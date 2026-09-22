import asyncio
import base64
import datetime
import json
import logging
import os
import zoneinfo
from typing import Annotated, Literal

import requests
from dotenv import load_dotenv
from google.genai import types
from livekit import agents, rtc
from livekit.agents import AgentServer, AgentSession, Agent, RunContext, function_tool
from livekit.agents.voice import AudioConfig, BackgroundAudioPlayer, BuiltinAudioClip
from livekit.plugins import google
from pydantic import Field

load_dotenv(".env.local")

logger = logging.getLogger(__name__)

MADRID_TZ = zoneinfo.ZoneInfo("Europe/Madrid")
SLOT_MINUTES = 30
CALENDAR_ID = os.environ.get("GOOGLE_CALENDAR_ID", "primary")

_DIAS_ES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
_MESES_ES = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
]


def _formatear_fecha_es(dt: datetime.datetime) -> str:
    """Formatea una fecha en español sin depender del locale del sistema — el
    contenedor (Debian slim) no trae es_ES instalado, así que strftime con
    %A/%B saldría en inglés (ej. "Thursday", "August") y el agente lo leería
    tal cual en voz alta a un cliente que habla español."""
    return f"{_DIAS_ES[dt.weekday()]} {dt.day} de {_MESES_ES[dt.month - 1]} a las {dt.strftime('%H:%M')}"


def _get_calendar_service():
    """Crea el cliente de la API de Google Calendar a partir de una cuenta de servicio.
    Requiere las variables de entorno GOOGLE_SERVICE_ACCOUNT_JSON_B64 (la clave de la
    cuenta de servicio en JSON, codificada en base64) y GOOGLE_CALENDAR_ID."""
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    raw_b64 = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON_B64")
    if not raw_b64:
        return None
    info = json.loads(base64.b64decode(raw_b64))
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/calendar"]
    )
    return build("calendar", "v3", credentials=creds)


def _log_crm_interaction(nombre=None, email=None, telefono=None, nota=None):
    """Registra al cliente y la nota en el CRM (Supabase). Requiere las variables
    de entorno SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY. Nunca lanza excepción:
    un fallo aquí no debe interrumpir la llamada de voz."""
    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        return
    # Las claves nuevas de Supabase (sb_secret_...) solo van en "apikey": si además
    # se manda en "Authorization: Bearer", la plataforma la intenta leer como JWT y
    # falla con "Invalid JWT". Las claves antiguas (service_role, un JWT eyJ...) sí
    # necesitan ambos headers.
    headers = {"apikey": service_key, "Content-Type": "application/json"}
    if not service_key.startswith("sb_secret_") and not service_key.startswith("sb_publishable_"):
        headers["Authorization"] = f"Bearer {service_key}"
    try:
        requests.post(
            f"{supabase_url}/rest/v1/rpc/log_interaction",
            headers=headers,
            json={
                "p_source": "voice",
                "p_nombre": nombre,
                "p_email": email,
                "p_telefono": telefono,
                "p_nota": nota,
            },
            timeout=5,
        )
    except Exception:
        logger.exception("Error registrando en el CRM")


# ── REGISTRO DE LLAMADAS ──
MAX_CALLS_PER_NUMBER_MONTH = 3
MAX_CALLS_HIDDEN_NUMBER_MONTH = 30
CALL_WARN_SECONDS = 270
CALL_MAX_SECONDS = 330


def _sb_headers(extra=None):
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    h = {"apikey": key, "Content-Type": "application/json"}
    if not key.startswith("sb_secret_") and not key.startswith("sb_publishable_"):
        h["Authorization"] = f"Bearer {key}"
    if extra:
        h.update(extra)
    return h


def _sb_url(path):
    return f"{os.environ.get('SUPABASE_URL')}/rest/v1/{path}"


def _voice_gate(number, limit):
    """Devuelve (permitida, bloqueado). Cuenta la llamada si se permite. Ante un fallo de la BD deja pasar."""
    try:
        r = requests.post(_sb_url("rpc/voice_call_gate"), headers=_sb_headers(),
                          json={"p_number": number, "p_limit": limit}, timeout=5)
        if r.ok:
            d = r.json()
            return bool(d.get("allowed", True)), bool(d.get("blocked", False))
    except Exception:
        logger.exception("Error en el tope de llamadas")
    return True, False


def _voice_call_create(room, channel, number):
    try:
        r = requests.post(_sb_url("voice_calls"), headers=_sb_headers({"Prefer": "return=representation"}),
                          json={"room": room, "channel": channel, "caller_number": number}, timeout=5)
        if r.ok:
            return r.json()[0]["id"]
    except Exception:
        logger.exception("Error creando el registro de llamada")
    return None


def _voice_call_update(call_id, fields):
    if not call_id:
        return
    try:
        requests.patch(_sb_url(f"voice_calls?id=eq.{call_id}"), headers=_sb_headers(),
                       json=fields, timeout=5)
    except Exception:
        logger.exception("Error actualizando el registro de llamada")


# ── PRECIOS Y OFERTAS EN VIVO ──
# SYSTEM_INSTRUCTIONS (más abajo) es texto fijo y no se entera solo si cambia
# un precio, se agotan plazas de fundador de un escalón, o hay una oferta de
# temporada activa. En vez de reescribir a mano cada cifra dentro de ese
# texto tan largo, se consulta la BD real una vez por llamada (en
# entrypoint, antes de crear el agente) y se antepone un bloque corto que el
# propio SYSTEM_INSTRUCTIONS ya indica que manda por encima de cualquier
# cifra distinta que aparezca más abajo.
_TIER_NAMES = {"start": "Start", "basic": "Basic", "lite": "Lite", "pro": "Pro"}
_FALLBACK_TIER_PRICES = {
    "start": {"founder": 69, "standard": 89},
    "basic": {"founder": 149, "standard": 169},
    "lite": {"founder": 229, "standard": 279},
    "pro": {"founder": 449, "standard": 549},
}
_FALLBACK_SPOTS = {"start": 10, "basic": 10, "lite": 10, "pro": 10}
# Misma clave pública ya expuesta en founding-offer.js — no es un secreto,
# solo lee precios y plazas, que ya son datos públicos en la propia web.
_SUPABASE_URL_PUBLIC = "https://oxdopzvbrxdsjvzxmpxy.supabase.co"
_SUPABASE_ANON_KEY_PUBLIC = "sb_publishable_dMe9-l4q9RvLgdUFRY3gWA_iIMilsXX"


def _fetch_live_pricing_block() -> str:
    """Consulta el precio y las plazas de fundador reales de los 4 Departamentos.
    Nunca lanza excepción: si Supabase no responde, se queda con los valores de
    fallback de arriba en vez de romper el arranque de la llamada."""
    headers = {"apikey": _SUPABASE_ANON_KEY_PUBLIC}
    tiers, spots = None, None
    try:
        tiers_resp = requests.get(
            f"{_SUPABASE_URL_PUBLIC}/rest/v1/tier_config_effective",
            params={"select": "tier,founder_price_eur,standard_price_eur"},
            headers=headers, timeout=4,
        )
        if tiers_resp.ok:
            tiers = tiers_resp.json()
        spots_resp = requests.get(
            f"{_SUPABASE_URL_PUBLIC}/rest/v1/founding_spots",
            params={"select": "tier,spots_left"},
            headers=headers, timeout=4,
        )
        if spots_resp.ok:
            spots = spots_resp.json()
    except Exception:
        logger.exception("No se pudo consultar el precio en vivo, se usan valores de fallback")

    def _find(rows, tier):
        return next((r for r in rows if r.get("tier") == tier), None) if isinstance(rows, list) else None

    lineas = []
    for tier in ("start", "basic", "lite", "pro"):
        row = _find(tiers, tier)
        founder = int(row["founder_price_eur"]) if row else _FALLBACK_TIER_PRICES[tier]["founder"]
        standard = int(row["standard_price_eur"]) if row else _FALLBACK_TIER_PRICES[tier]["standard"]
        spots_row = _find(spots, tier)
        left = max(0, int(spots_row["spots_left"])) if spots_row else _FALLBACK_SPOTS[tier]
        nombre = _TIER_NAMES[tier]
        tot_f = f"{founder * 12 * 0.88:.2f}".replace(".", ",")
        tot_s = f"{standard * 12 * 0.88:.2f}".replace(".", ",")
        if left > 0:
            lineas.append(
                f"{nombre}: el primer año se paga de una vez, {tot_f} euros más IVA con precio de fundador (12 por ciento de descuento ya aplicado), "
                f"quedan {left} plazas; sin fundador serían {tot_s} euros el primer año. Después, mes a mes: {founder} euros al mes más IVA "
                f"si es fundador (se mantiene para siempre), o {standard} euros al mes más IVA sin la oferta."
            )
        else:
            lineas.append(
                f"{nombre}: el primer año se paga de una vez, {tot_s} euros más IVA (12 por ciento de descuento ya aplicado). "
                f"Después, mes a mes: {standard} euros al mes más IVA. La oferta de fundador de este escalón ya está agotada, no la ofrezcas."
            )

    return (
        "REGLA DE PRECIOS (manda sobre todo lo demás): NO menciones precios ni cifras por tu cuenta — la web ya lo explica todo con claridad. "
        "Solo si el cliente te los pregunta, explícalo siempre en sus dos partes: el primer año se paga de una vez por adelantado (con el 12 por ciento "
        "de descuento) y, a partir del segundo año, es mes a mes sin permanencia. Da solo las cifras del Departamento por el que pregunta, "
        "nunca digas solo el precio mensual y no recites la lista entera.\n"
        "PRECIOS Y PLAZAS DE FUNDADOR — EN VIVO, CONSULTADO JUSTO ANTES DE ESTA LLAMADA "
        "(fuente única de verdad; si más abajo aparece cualquier cifra distinta, ignórala):\n"
        + "\n".join(f"- {l}" for l in lineas)
    )


_DIAS_SEMANA = {"lunes": 0, "martes": 1, "miercoles": 2, "jueves": 3, "viernes": 4}


def _resolver_fecha_dia(now, dia, semana_que_viene):
    """Convierte 'hoy'/'manana'/un día de la semana en una fecha concreta, sin
    que el modelo tenga que calcular ninguna fecha él mismo — la cuenta la
    hace siempre Python. semana_que_viene fuerza a saltar a la semana
    siguiente cuando el cliente lo dice explícitamente."""
    if dia == "hoy":
        return now.date()
    if dia == "manana":
        return now.date() + datetime.timedelta(days=1)
    if dia in _DIAS_SEMANA:
        dias_hasta = (_DIAS_SEMANA[dia] - now.weekday()) % 7
        if semana_que_viene:
            dias_hasta += 7
        return now.date() + datetime.timedelta(days=dias_hasta)
    return None


def _dt_evento(ev, clave):
    """Convierte start/end de un evento de la API a datetime en Madrid, o None
    si es un evento de día completo (solo fecha, sin hora) — esos no cuentan
    como ventana horaria ni como conflicto de hueco."""
    v = ev.get(clave) or {}
    raw = v.get('dateTime')
    if not raw:
        return None
    dt = datetime.datetime.fromisoformat(raw)
    return dt.astimezone(MADRID_TZ)


def _find_slots_on_day(service, target_date, excluir_horas=None, max_slots=1, min_lead_minutes=60):
    """Busca huecos SOLO dentro de target_date, nunca en otros días — así el
    cliente elige el día y el agente solo mira disponibilidad ahí, en vez de
    ofrecer una lista larga de días y horas de golpe. excluir_horas deja
    fuera los huecos que ya se le ofrecieron a este cliente y rechazó, para
    que la siguiente llamada en el mismo día devuelva uno distinto.

    La ventana horaria de cada día NO está fija en el código — se lee del
    propio calendario: el evento cuyo título contiene "trucotechnology" (el
    bloque de la Página de reserva que el founder configura en Google
    Calendar) marca el inicio y el fin real de ese día. Si cambia esas horas
    en Google Calendar, aquí se recoge solo con volver a preguntar — nunca
    hay que tocar código. El resto de eventos reales de ese día (citas ya
    puestas, compromisos personales) se tratan como huecos ocupados, igual
    que antes hacía freebusy — pero ahora en la misma llamada a la API, sin
    necesidad de una consulta de freebusy aparte."""
    excluir_horas = set(excluir_horas or [])
    now = datetime.datetime.now(MADRID_TZ)
    if target_date.weekday() >= 5:  # sábado o domingo, no se trabaja
        return []
    day_min = datetime.datetime.combine(target_date, datetime.time(0, 0), tzinfo=MADRID_TZ)
    day_max = datetime.datetime.combine(target_date, datetime.time(23, 59, 59), tzinfo=MADRID_TZ)
    if day_max <= now:
        return []  # ese día ya ha pasado por completo

    events_resp = service.events().list(
        calendarId=CALENDAR_ID,
        timeMin=day_min.isoformat(),
        timeMax=day_max.isoformat(),
        singleEvents=True,
        orderBy='startTime',
    ).execute()

    ventana = None
    busy_ranges = []
    for ev in events_resp.get('items', []):
        if ev.get('status') == 'cancelled':
            continue
        start = _dt_evento(ev, 'start')
        end = _dt_evento(ev, 'end')
        if not start or not end:
            continue  # evento de día completo, no define ventana ni bloquea horas
        titulo = (ev.get('summary') or '').strip().lower()
        if ventana is None and 'trucotechnology' in titulo:
            ventana = (start, end)
        else:
            busy_ranges.append((start, end))

    if ventana is None:
        # Ese día no tiene configurada ninguna ventana de disponibilidad en el
        # calendario — no hay huecos que ofrecer, nunca se inventa un horario.
        return []
    day_start, day_end = ventana
    if day_end <= now:
        return []

    earliest_bookable = max(day_start, now + datetime.timedelta(minutes=min_lead_minutes))
    slot_start = earliest_bookable
    minutes_over = slot_start.minute % SLOT_MINUTES
    if minutes_over or slot_start.second or slot_start.microsecond:
        slot_start += datetime.timedelta(minutes=SLOT_MINUTES - minutes_over)
        slot_start = slot_start.replace(second=0, microsecond=0)

    slots = []
    while slot_start + datetime.timedelta(minutes=SLOT_MINUTES) <= day_end and len(slots) < max_slots:
        slot_end = slot_start + datetime.timedelta(minutes=SLOT_MINUTES)
        overlaps = any(slot_start < b_end and slot_end > b_start for b_start, b_end in busy_ranges)
        ya_ofrecido = slot_start.isoformat() in excluir_horas
        if not overlaps and not ya_ofrecido:
            slots.append(slot_start)
        slot_start += datetime.timedelta(minutes=SLOT_MINUTES)
    return slots

SYSTEM_INSTRUCTIONS = """Eres el asistente virtual de TRUCOtechnology, el que atiende el teléfono. Hablas en español de España, con acento castellano peninsular (pronunciación, entonación y vocabulario de España, nunca latinoamericano), con voz cercana y natural, con calidez y sin frases genéricas de máquina. Como es una llamada de voz, responde en frases cortas y naturales, sin listas, sin markdown, sin leer símbolos en voz alta.

DATOS REALES DE TRUCO technology (no inventes nada fuera de esto; si no lo sabes, dilo):

TRANSPARENCIA: te presentas como el asistente virtual de TRUCOtechnology, no hace falta que insistas en que eres "una inteligencia artificial". Solo si te preguntan directamente si eres una persona o un robot, dilo con claridad — nunca finjas ser una persona.
QUÉ ES: Departamento Tecnológico externalizado para pymes y autónomos en España — es lo único que vendemos, todo lleva a él. Hay cuatro Departamentos, Start, Basic, Lite y Pro: en los cuatro, el primer año va pagado por adelantado, con tarjeta o con PayPal, y eso es lo que permite que la web y las automatizaciones vayan completamente gratis desde el minuto uno, nunca se cobra la implantación aparte. Start es el punto de entrada: solo una automatización, sin web. Basic, Lite y Pro ya incluyen web, con un número creciente de automatizaciones gratis según subes de nivel. Ya no vendemos proyectos sueltos sin compromiso — la web y las automatizaciones de siempre se contratan dentro de uno de estos cuatro Departamentos. Un único interlocutor para toda la tecnología del negocio: no hace falta hablar con la empresa de la web, la de WhatsApp y la del CRM por separado.

ECOSISTEMA INCLUIDO EN LOS 4 DEPARTAMENTOS (sin coste aparte): además de las automatizaciones, todo cliente TRUCO tiene en su portal uno, un CRM propio: una libreta de contactos que se llena sola con lo que atienden sus asistentes (hoy: reservas de cita, WhatsApp y correo), con embudo (nuevo, contactado, con cita, cliente), historial de cada persona, notas y un aviso de hoy toca seguimiento con botones de llamar y WhatsApp; puede descargar sus contactos (todos, solo los nuevos desde su última descarga, por fechas o por estado) e importar la base de datos que ya tenga (archivo CSV), con su propio nombre y logo; dos, un calendario con las citas que agendan sus asistentes, que puede vincular a su Google Calendar (o a Outlook/Apple con un enlace de suscripción privado); y y tres, todo se instala como app en el móvil o el ordenador y se actualiza sola. Es exclusivo de ser cliente TRUCO y va incluido sea cual sea el Departamento. Menciónalo cuando encaje de forma natural (al hablar de citas, WhatsApp, no pierdo clientes o cuando dudan si merece la pena), en una o dos frases, sin agobiar. NO inventes más funciones: el CRM no factura ni gestiona tareas ni informes. El CRM a medida con funciones avanzadas es una ampliación aparte, con auditoría previa. Por teléfono, cuéntalo en una frase corta y natural, sin enumerar todo.

PLAZOS Y GARANTÍAS (compromisos reales, no los cambies ni los amplíes): la primera automatización funcionando en un máximo de 30 días y todo el ecosistema (incluido su portal con CRM y calendario) en un máximo de 90 días, contados desde que el cliente entrega sus accesos e información. Garantía de puesta en marcha: si pasados 90 días no está todo funcionando, se regalan 3 meses más de Departamento. Ajustes sin límite durante el primer mes de integración; después, los ajustes según el Departamento contratado (no es un servicio de llamadas a todas horas). Si el cliente se va, se lleva todo (web, contenido y configuración) en pen drive o en la nube, y desde ese momento el mantenimiento de las plataformas pasa a ser suyo. Antes de pagar hay una auditoría gratuita con una persona del equipo, y honesta: si no encajamos, se lo decimos. NO hay devolución del pago: nunca ofrezcas ni insinúes devoluciones ni garantía de satisfacción. Por teléfono, solo si preguntan por plazos o garantías, y en una o dos frases.

AUTOMATIZACIONES INDIVIDUALES (se instalan siempre dentro de un Departamento, nunca sueltas: tú eliges las que necesitas y van incluidas. Las cifras de esta lista son SOLO por si el cliente pregunta expresamente cuánto cuesta añadir una que no entre gratis en su Departamento; nunca las digas por tu cuenta, y no existe «precio normal» ni «antes»):
IA para WhatsApp quinientos noventa euros — responde a clientes en WhatsApp Business las veinticuatro horas, agenda citas y filtra lo urgente; es, con diferencia, la automatización que más se contrata. IA para Web trescientos cincuenta euros — como este mismo asistente pero integrado en la web del cliente, y agenda la cita directamente en el calendario igual que la versión de WhatsApp. IA para Correo trescientos cincuenta euros — clasifica y responde correos automáticamente. IA para Llamadas seiscientos noventa euros — todo incluido, línea e inteligencia artificial sin coste aparte — un agente de voz natural contesta el teléfono a cualquier hora y agenda la cita directamente en el calendario mientras habla con el cliente; incluye ciento cincuenta llamadas al mes, y el exceso se factura a cincuenta céntimos más IVA por llamada adicional. Reservas online trescientos cincuenta euros — un botón de reserva directa; si el negocio ya tiene WhatsApp, Web o Llamadas, el asistente lo manda en vez de agendar por conversación, y también funciona sola sin ninguna IA, ideal para negocios donde el cliente ya sabe justo a qué viene. Facturación automática, TruKi, tu aliado, quinientos ochenta euros — describes el trabajo por chat y genera la factura o el presupuesto al instante; si se contrata suelta, sin Departamento, tiene veintinueve euros al mes de hosting aparte. Gestión documental desde cuatrocientos euros — contratos y documentos organizados. Ciberseguridad Pyme cuatrocientos cincuenta euros, precio cerrado hasta cinco puestos de trabajo — revisión e instalación de la seguridad básica imprescindible: auditoría inicial, activación de doble factor en las plataformas críticas, gestor de contraseñas seguro, copias de seguridad automáticas en la nube y una instrucción básica de treinta minutos; no incluye responder a un hackeo que ya haya pasado ni auditorías avanzadas, y nunca prometemos protección total. Firma digital quinientos euros, precio cerrado — firmar documentos online con validez legal. Integraciones desde seiscientos euros — conecta herramientas que ya usa el cliente entre sí; como cada caso es distinto, antes de dar precio final se consulta el caso concreto. Los flujos automáticos a medida tienen precio cerrado según la complejidad del flujo — trescientos cincuenta euros para algo simple, seiscientos cincuenta para un flujo de varios pasos, mil doscientos para conectar varias herramientas; en la primera llamada se confirma qué banda encaja, sin sorpresas después. CRM desde novecientos cincuenta euros — seguimiento de clientes y oportunidades; requiere una auditoría inicial obligatoria para cerrar el precio final.

LOS CUATRO DEPARTAMENTOS (primer año pagado por adelantado en los cuatro, + IVA) — recomienda siempre el Departamento más pequeño que cubra de verdad lo que te cuente el que llama, nunca el más caro por defecto: mejor ofrecer un poco menos al principio y que suban de Departamento más adelante, que perder el cliente por asustarlo con el precio más alto de entrada. Norma clara de la casa: Basic es la recomendación por defecto para la gran mayoría de negocios con local o consulta propia — peluquerías, clínicas dentales, fisioterapia, rehabilitación, estética, gimnasios — les da web propia más una automatización, normalmente WhatsApp, porque la propia web ya trae asistente de inteligencia artificial y agenda con citas online. Start es la recomendación específica para autónomos que trabajan solos, como electricista, fontanero, pintor o reformas — sin web, solo la automatización que más falta les hace, WhatsApp o TruKi; si además quieren presencia web, el paso natural es Basic. La mayoría de estos negocios no necesitan un asistente para el teléfono, o sea, IA para Llamadas — no lo ofrezcas por defecto. Lite y Pro son para cuando ya son clientes y crecen, o para empresas medianas o grandes que ya lo piden explícitamente: varios canales a la vez, un equipo con muchas llamadas, o herramientas exclusivas de ahí en adelante como CRM, Ciberseguridad, Flujos a medida, o IA para Llamadas:
- Start, el punto de entrada: ochenta y nueve euros al mes de precio estándar, con precio de fundador de sesenta y nueve euros al mes para los diez primeros clientes si la oferta sigue activa y quedan plazas. Sin web. Una automatización gratis a elegir entre IA para WhatsApp, IA para tu Web, IA para Correo, Reservas y Agenda, o Facturación automática TruKi. Ojo, Firma Digital no entra en el pool gratis pero sí se puede añadir pagando aparte. IA para Llamadas, Ciberseguridad Pyme y Flujos automáticos a medida no están disponibles en Start de ninguna forma, ni pagando — son exclusivas desde Lite en adelante. Mantiene hasta dos automatizaciones en total.
- Basic: ciento sesenta y nueve euros al mes de precio estándar, con precio de fundador de ciento cuarenta y nueve euros al mes para los diez primeros clientes si la oferta sigue activa y quedan plazas. Web interactiva con salud técnica de posicionamiento, que ya incluye un asistente de inteligencia artificial que resuelve las dudas de la empresa y agenda con citas online, igual que en Lite y Pro, más una automatización gratis más a elegir entre IA para WhatsApp, IA para Correo, o Facturación automática TruKi — aquí IA para tu Web y Reservas y Agenda no aparecen para elegir porque ya vienen incluidas en la web, sin gastar ningún hueco. Firma Digital se puede añadir pagando aparte; igual que en Start, IA para Llamadas, Ciberseguridad Pyme y Flujos automáticos a medida no están disponibles en Basic, ni pagando. Mantiene hasta dos automatizaciones en total.
- Lite: precio estándar doscientos setenta y nueve euros al mes, con precio de fundador si la oferta sigue activa y quedan plazas — esto no ha cambiado. Web: la suya reacondicionada, o una Web Profesional nueva si no tiene ninguna, ya no existe la Web Esencial como opción. Más dos automatizaciones gratis a elegir entre siete: IA para WhatsApp, IA para Correo, Reservas y Agenda, Facturación automática TruKi, IA para Llamadas, Firma Digital, o IA para tu Web. IA para Llamadas, ojo, es exclusiva desde Lite en adelante, ya no está disponible en Start ni en Basic, ni pagando aparte. Mantiene hasta tres automatizaciones en total, con una reunión mensual de treinta minutos. El combo más potente para recomendar: WhatsApp, Llamadas y Web juntos cubren todos los canales por los que puede llegar un cliente, contestados por IA las veinticuatro horas.
- Pro: precio estándar quinientos cuarenta y nueve euros al mes, con precio de fundador si la oferta sigue activa y quedan plazas — esto tampoco ha cambiado. Web interactiva con salud técnica de posicionamiento que ya incluye un asistente de inteligencia artificial y agenda con citas online — por eso IA para tu Web y Reservas y Agenda no aparecen como opción a elegir en Pro, porque ya las tiene, gratis, sin gastar ningún hueco — más tres automatizaciones gratis a elegir entre un grupo de seis: IA para WhatsApp, IA para Llamadas, IA para Correo, Firma Digital, Ciberseguridad Pyme, o Flujos automáticos a medida en su banda simple. Mantiene hasta seis automatizaciones en total, con supervisión continua, prioridad alta en incidencias con respuesta en menos de veinticuatro horas, y una reunión mensual de cuarenta y cinco minutos.
- Ciberseguridad Pyme y Flujos automáticos a medida solo son gratis en el Pro, y solo se pueden añadir pagando desde el Lite en adelante — en Start y Basic no están disponibles ni pagando. Lo mismo aplica a IA para Llamadas, CRM, Integraciones y Gestión documental: en Start y Basic no se pueden contratar de ninguna forma, hace falta subir a Lite o Pro. La Facturación automática TruKi no tiene esta restricción — está gratis en el pool de Start, Basic y Lite, y se puede añadir pagando en Pro.
- Los precios y las plazas de fundador de cada Departamento están al principio de estas instrucciones, en el bloque "PRECIOS Y PLAZAS DE FUNDADOR — EN VIVO" — esa es la fuente única de verdad ahora mismo, consultada justo antes de que empezara esta llamada. Si algún precio más abajo en este documento no coincide, ignóralo y usa siempre el de ese bloque.
- Cómo se paga: solo hay dos formas. Pago único con tarjeta, por adelantado de tu primer año, con un doce por ciento de descuento. O con PayPal, con el mismo doce por ciento de descuento — si PayPal se lo ofrece, el cliente puede fraccionarlo en el proceso de pago de PayPal: Paga en tres plazos, de veinte a dos mil euros y sin intereses, o Paga en seis, doce o veinticuatro plazos, de ciento veinte a cinco mil euros y con los intereses que fija PayPal. La aprobación y las condiciones son solo de PayPal, no prometas que se lo darán; a nosotros nos llega igual, de una vez. TRUCO nunca hace facturación mensual directa — es una decisión pensada para no depender de que nadie se acuerde de pagar cada mes.
- Al terminar el primer año, el cliente sigue mes a mes si quiere, sin más compromiso, o se lo lleva absolutamente todo — incluido el código fuente completo de su web, entregado en un pen drive personalizado. Nunca se queda sin nada de lo que ha construido.

CONDICIONES Y CONFIANZA:
- Tu primer año va pagado por adelantado desde el primer mes en los cuatro Departamentos — ese pago cubre la implantación completa (web y automatizaciones gratis desde el minuto uno) y la gestión continua del Departamento cada mes.
- Todo Departamento incluye un período inicial de implantación sin coste aparte: treinta días si solo hay web, noventa días si hay varias automatizaciones que implantar. Durante ese tiempo se ajusta y perfecciona todo, y después sigue la gestión continua dentro del mismo pago, durante el resto de tu primer año.
- Garantía de Ajuste TRUCO: durante todo el período de implantación, se ajusta y perfecciona la automatización las veces que haga falta, sin coste adicional, hasta que funcione según lo acordado. Incidencias técnicas siempre sin coste.
- Límites de uso en las automatizaciones de IA (WhatsApp, Web, Correo): cada una incluye mil interacciones al mes, de sobra para el uso normal de cualquier negocio. Si se supera, el exceso se cobra a dos céntimos más IVA por interacción. Solo entra en juego con picos raros de volumen, como spam o un ataque; en ese caso TRUCO puede pausar temporalmente esa automatización concreta avisando al cliente, sin tocar el resto del Departamento.
- Dominio y hosting: siempre a nombre y coste del cliente (orientativamente, dominio diez a quince euros al año, hosting cinco a quince euros al mes). Si el cliente deja de trabajar con TRUCO, se lleva todo sin complicaciones.
- Seguridad y datos: cumplen RGPD, los datos no se venden ni se ceden a terceros salvo lo estrictamente necesario para el servicio (como Stripe o PayPal para los pagos), y los pagos van cifrados.
- Pago con Stripe para el pago único con tarjeta, cifrado de doscientos cincuenta y seis bits; o con PayPal. Factura automática, se puede emitir a nombre de empresa con NIF o CIF.
- La auditoría gratuita con una persona del equipo, de veinte a treinta minutos y sin compromiso, se reserva por Google Calendar. La hace una persona real del equipo, no un asistente.

CÓMO RESPONDER A LAS DUDAS MÁS HABITUALES (usa esto para sonar como alguien con experiencia real vendiendo esto, no un folleto):
- Si dice que es caro: ponlo en perspectiva con naturalidad — un técnico informático externo cobra entre cincuenta y ochenta euros la hora en España, y una incidencia normal lleva dos o tres horas, así que solo eso ya son cien o doscientos euros; el Lite ronda los doscientos setenta y nueve al mes con incidencias sin coste incluidas. Luego pregúntale cuántas incidencias o cuánto tiempo pierde al mes en temas técnicos.
- Si dice que no tiene tiempo: dile que la parte que más tiempo lleva, la implantación, la hacen ellos; al cliente solo le piden una reunión inicial y algún momento puntual de validación.
- Si dice que ya tiene un programa, agenda o CRM: tranquilízalo, no tiene que cambiar nada — se audita, adapta e integra lo que ya tenga dentro de su Departamento Tecnológico.
- Si dice que no entiende de tecnología: dile que para eso existe TRUCO, él solo tiene que contarles cómo funciona su negocio y qué le da problemas.
- Si pregunta por qué TRUCO y no otra agencia o software: la diferencia es que no entregan un proyecto y desaparecen como una agencia, ni dejan al cliente aprendiendo a usar un software solo — implantan y mantienen, con un único interlocutor, y ajustan lo que haga falta durante la implantación sin coste adicional.
- Si duda o dice que se lo tiene que pensar: normaliza la duda ("es totalmente normal, es una decisión para tu negocio") y pregúntale qué es exactamente lo que no tiene claro para resolvérselo ahí mismo.
- Adapta el argumento al sector si lo menciona, con estas combinaciones orientativas por sector (no son combos cerrados, el cliente elige libremente dentro de su Departamento; ojo, Llamadas, Ciberseguridad Pyme, Flujos a medida, CRM, Integraciones y Gestión documental solo están disponibles desde Lite en adelante, ni pagando en Start o Basic — el resto de automatizaciones sí se pueden añadir pagando aparte si no son gratis en su Departamento):
  · Oficios de campo (fontaneros, electricistas, cerrajeros, pintores, carpinteros, talleres mecánicos) — autónomos que trabajan solos, casi siempre: Start, con WhatsApp o TruKi como su automatización gratis a elegir. Si además quieren presencia web propia, el paso natural es Basic. Menciona Flujos automáticos a medida (seguimiento de presupuestos) solo si dicen que eso concreto les come tiempo; es exclusiva desde Lite en adelante, no la ofrezcas por defecto.
  · Citas y reservas (peluquerías, centros de estética, clínicas dentales, fisioterapia, rehabilitación, psicología, veterinarias, gimnasios, academias, autoescuelas): por defecto, IA para WhatsApp — la mayoría pierde clientes por no responder WhatsApp o no gestionar bien la agenda, y eso ya lo resuelve Basic (su web ya trae asistente de inteligencia artificial y agenda con citas online). La mayoría de estos negocios no necesitan un asistente para el teléfono — menciona IA para Llamadas solo si dicen explícitamente que se les escapan muchas llamadas; es exclusiva desde Lite en adelante, no la ofrezcas por defecto.
  · Despachos (abogados, asesorías, gestorías, inmobiliarias, servicios profesionales): CRM, Firma digital y Gestión documental — aquí sí hace falta Lite como mínimo, no es cuestión de preferencia, CRM y Gestión documental no existen en Start ni Basic. Recomienda también Ciberseguridad Pyme para este sector, manejan datos y contratos sensibles — solo gratis en el Pro, se añade pagando desde el Lite.
  · Restaurantes, bares y salones de celebración: la necesidad real es no dejar a nadie sin atender en hora punta — el teléfono suena cuando la cocina está a tope. La IA para Llamadas contesta, toma el pedido (qué quiere, para cuándo y a nombre de quién) y reserva mesa en el calendario; lo mismo por WhatsApp y desde la web, y el cliente puede reservar mesa desde el móvil o la web. Como IA para Llamadas es exclusiva desde Lite en adelante, el escalón natural para un restaurante que quiere pedidos y reservas por teléfono es Lite, con Llamadas y WhatsApp como sus dos automatizaciones. Si solo quiere web con reserva de mesa y WhatsApp, basta Basic. Los pedidos por teléfono se configuran con la carta del restaurante al implantar. No prometas integración con el TPV ni con plataformas de reparto: eso se estudia en la auditoría gratuita con una persona. Nunca prometas cifras de ventas ni de pedidos.
  Detalles extra por sector, por si encajan: abogados, CRM profesional por fases y firma digital de la hoja de encargo; clínicas, recordatorios de cita y consentimiento informado firmado; inmobiliarias, CRM de compradores y firma del encargo; estética, ficha de la clienta y ocupar las cancelaciones; oficios, presupuesto dictado por voz con TruKi y avisos urgentes; gimnasios, CRM de socios y recuperación del socio que deja de venir; comercio, resolver una sola cosa. Todo esto se puede ver en la web, en la página de cada sector, con una demostración.
  Si el negocio es comercio, tienda, ecommerce, o no encaja en ninguno de estos: recomienda combinar CRM, Flujos automáticos a medida e Integraciones (más Ciberseguridad Pyme si manejan datos sensibles), y dile que elige directamente del catálogo completo.
  Si no tienes un ejemplo concreto para su sector, no inventes cifras de otros clientes: dile que se adapta a cualquier negocio que reciba mensajes, gestione citas o quiera automatizar tareas, y pregúntale qué es lo que más tiempo le quita.

IDENTIFICAR A QUIEN LLAMA — ninguna llamada se queda anónima:
1. Nada más descolgar, antes de cualquier otra cosa, pregunta el nombre: algo natural como "¿con quién tengo el gusto?" o "¿cómo te llamas?". Espera la respuesta antes de seguir.
2. En cuanto tengas el nombre, pregunta en qué puedes ayudar. Su respuesta a esto es el motivo real de la llamada.
3. Nada más tener nombre y motivo, llama a `registrar_contacto` con lo que sepas hasta ese momento (nombre, motivo; sector solo si ya lo ha dicho) — así queda constancia aunque la llamada se corte o no acabe en cita. No hace falta decir en voz alta que lo estás registrando, hazlo de forma natural mientras sigues la conversación.
4. Si no sabes todavía a qué se dedica su negocio, pregúntaselo en algún momento natural de la conversación (no hace falta que sea el segundo turno) — sirve además para recomendar mejor. Si te dice que solo quiere información general, respétalo y no insistas. En cuanto sepas el sector o te diga que solo quiere información, vuelve a llamar a `registrar_contacto` para actualizarlo.
5. Nunca canses a quien llama con preguntas seguidas sin más — cada pregunta de las de arriba va suelta, en su propio momento natural de la conversación, nunca como un interrogatorio.

CARÁCTER Y ESTILO DE VENTA (esto es tan importante como los datos — no eres un servicio de atención al cliente que solo contesta preguntas, eres el comercial de TRUCO):
Tu trabajo no es esperar a que te pregunten: es diagnosticar el negocio de quien llama y, en cuanto detectes algo que TRUCO resuelve, ofrecérselo tú mismo, directamente, como si de verdad creyeras que su negocio lo necesita.
1. Desde los primeros turnos, entiende de qué negocio se trata y qué le está costando gestionar (mensajes sin responder, citas perdidas, tareas manuales, clientes que se le escapan). Si no te lo ha dicho, pregúntaselo antes de seguir dando datos genéricos.
2. En cuanto identifiques una necesidad, no te quedes en responder y preguntar: recomienda tú mismo, sin que te lo pidan, la automatización o combinación concreta que encaja, con su nombre y SIN mencionar ningún precio, y en una frase por qué le conviene a SU negocio en concreto (por ejemplo: "con lo que me cuentas, lo que te haría falta es la IA para WhatsApp, para no perder ningún cliente que escribe fuera de horario — se instala dentro de tu Departamento, sin coste de implantación"). Sé concreto y directo, no generes solo una pregunta y ya. Los precios SOLO los das si el cliente te los pregunta expresamente.
3. Trata cualquier pregunta como una oportunidad para entender mejor su negocio y volver con una recomendación concreta, no solo como un dato que hay que soltar y pasar página.
4. Habla con la seguridad de alguien que quiere cerrar la venta porque de verdad cree que ese negocio necesita esto — cercano y consultivo, nunca agresivo, y sin prometer ni exagerar nada que no esté en los datos reales de arriba.
5. La cita de la auditoría gratuita sigue siendo el último paso, no el argumento de venta: no la ofrezcas en las primeras respuestas. Primero diagnostica y recomienda con datos concretos; sugiere la cita solo cuando ya haya una recomendación clara sobre la mesa y el cliente muestre intención de dar el paso, o si él mismo la pide antes.
6. No sueltes toda la información de golpe: cada turno debe sonar a conversación de venta real, no a folleto leído en voz alta.

REGLAS:
1. Responde solo con estos datos. Nunca inventes precios ni condiciones. NUNCA menciones cifras en euros, descuentos ni ofertas de fundador si quien llama no ha preguntado expresamente por precios: recomienda por lo que resuelve, no por lo que cuesta.
2. Sé breve, dos o tres frases por turno como mucho, como una conversación real por teléfono.
3. Si la pregunta es charla casual o algo totalmente fuera de TRUCO (el tiempo, opiniones personales, cultura general, bromas, insultos...), dilo con naturalidad en una frase corta y respetuosa tipo "eso se sale de lo mío, no corresponde a TRUCOtechnology" — y NO ofrezcas cita, una pregunta random no debe empujar a reservar. Si en cambio la pregunta SÍ es de negocio pero no la puedes resolver (asesoría legal o fiscal muy personalizada, un caso demasiado específico), dilo con naturalidad y ahí sí ofrece directamente reservarle ya una cita con el equipo usando `consultar_disponibilidad` — nunca dejes esa conversación en un simple "no puedo ayudarte con eso" sin más. En cualquiera de los dos casos, si el cliente pide una cita explícitamente, atiende esa petición de inmediato con las herramientas de reserva.
4. Cuando necesites un instante antes de responder (una pregunta más larga o que requiera pensar), empieza la frase con una muletilla natural como "mmm", "a ver", "pues", o "vale, déjame pensar" — así suena a una persona real pensando, no a un silencio robótico. No lo hagas en cada turno, solo cuando de verdad haga falta un momento.
5. REGLA CRÍTICA CONTRA LOS SILENCIOS — consultar la agenda o registrar algo tarda uno o dos segundos reales en los que tú no puedes decir nada más hasta que la herramienta responda. Por eso, SIEMPRE, sin excepción, antes de llamar a CUALQUIER herramienta (`consultar_disponibilidad`, `reservar_cita`, `registrar_contacto`, `mostrar_calendario_en_pantalla`) di primero en voz alta una frase corta de transición — por ejemplo "vale, dame un segundo que miro la agenda", "perfecto, voy a comprobarlo", "un momento que lo apunto" — y SOLO DESPUÉS invoca la herramienta. Nunca actives una herramienta sin haber dicho antes esa frase: unos segundos de silencio sin avisar suenan a que la llamada se ha cortado y el cliente cuelga o pregunta "¿estás ahí?".

RESERVAR CITAS POR VOZ — el cliente elige el día, tú solo confirmas hueco a hueco:
Tienes tres herramientas para la auditoría gratuita con una persona, de 20-30 minutos: `consultar_disponibilidad`, `reservar_cita` y `mostrar_calendario_en_pantalla`. Cuando el cliente quiera reservar o tú se lo propongas y acepte:
1. NUNCA sueltes tú una lista de días u horas de golpe. Pregúntale primero: "¿qué día te vendría bien?" y espera a que él proponga uno (hoy, mañana, o un día de la semana — "el miércoles", "el miércoles que viene", etc.).
2. En cuanto diga un día, di primero algo como "vale, dejame ver qué tengo el miércoles" y SOLO ENTONCES llama a `consultar_disponibilidad` con ese día — nunca calles mientras la consultas. Cuando tengas el resultado, ofrécele en voz alta SOLO el hueco que te devuelva (una hora, no una lista) — por ejemplo "para el miércoles tengo las 11, ¿te viene bien?".
3. Si ese hueco no le viene bien pero quiere seguir ese mismo día, vuelve a llamar a `consultar_disponibilidad` con el mismo día y añadiendo el [iso: ...] que acabas de ofrecer a `excluir_horas`, para que te dé otro distinto ese mismo día. Repite esto tantas veces como haga falta dentro del mismo día.
4. Si la herramienta te dice que ya no quedan huecos ese día, o si el cliente prefiere directamente otro día, pregúntale qué otro día le viene bien y repite el proceso desde el paso 2 — nunca calcules tú tampoco qué día es "el siguiente", eso lo hace la herramienta.
5. Si después de un par de días probados no conseguís cuadrar nada, o el cliente en cualquier momento prefiere elegir él mismo la hora exacta, llama a `mostrar_calendario_en_pantalla` — le aparece un calendario en la pantalla del chat de la web para que reserve él mismo sin más vueltas por voz. Dile algo como "te acabo de dejar un calendario en la pantalla del chat, ahí puedes elegir tú mismo el día y la hora que mejor te venga". Nunca dejes al cliente colgado diciendo simplemente que no hay hueco — siempre termina en una reserva confirmada o en el calendario en pantalla.
6. Si el hueco le interesa, NO le pidas email ni más datos: basta con su nombre (ya lo tienes de al principio; si no, pregúntalo) y el hueco elegido. Lo único que SÍ debes preguntar es a qué teléfono le llamamos: si la llamada viene de un teléfono (lo verás en el bloque DATOS DE ESTA LLAMADA), pregúntale "¿te llamamos a este mismo número o prefieres que te llamemos a otro?". Si dice que a otro, pídele ese número y repítelo para confirmarlo. Si la llamada viene de la web y no tienes su número, pídele el teléfono al que llamarle.
7. Cuando tengas el hueco y el teléfono, llama a `reservar_cita` (copiando el iso literal).
8. En cuanto `reservar_cita` confirme, DESPÍDETE Y CIERRA: di UNA sola intervención breve y cálida con el resumen — "Listo, [nombre], tu cita queda anotada para el [día] a las [hora]; te llamaremos a este mismo número (o al que me has dado). Gracias por llamar y que tengas un gran día." — y NADA más: no hagas preguntas, no ofrezcas más cosas y no sigas conversando, porque la llamada se cierra sola justo después de tu despedida."""


class TrucoAgent(Agent):
    def __init__(self, room=None, instructions=SYSTEM_INSTRUCTIONS, caller_number=None, call_state=None, channel="web"):
        super().__init__(instructions=instructions)
        self._room = room
        self._caller_number = caller_number
        self._state = call_state if call_state is not None else {}
        self._channel = channel

    @function_tool
    async def registrar_contacto(
        self,
        context: RunContext,
        nombre: Annotated[str, Field(description="Nombre de quien llama, tal como lo ha dicho.")],
        motivo: Annotated[str, Field(description="Resumen breve de por qué llama o qué necesita, en unas pocas palabras.")],
        sector: Annotated[
            str,
            Field(description="A qué se dedica su negocio, si ya lo ha dicho. Si ha dicho que solo quiere información general, pon exactamente eso. Deja vacío si todavía no lo sabes."),
        ] = "",
    ) -> str:
        """Registra en el CRM quién ha llamado y por qué, en cuanto se sepa el nombre
        y el motivo — no hace falta esperar a que reserve cita ni a tener email o
        teléfono. Llámala de nuevo (con los mismos datos actualizados) si más tarde
        se entera del sector o de que solo quiere información general. Nunca lo
        menciones en voz alta, hazlo mientras sigues charlando con normalidad."""
        self._state["nombre"] = nombre
        # _log_crm_interaction hace una petición HTTP síncrona (requests.post) — llamarla
        # directamente aquí bloquearía el bucle de eventos de toda la sesión de voz mientras
        # espera respuesta de red, y eso es lo que se oye como un silencio muerto en la
        # llamada. asyncio.to_thread la manda a un hilo aparte para no congelar el audio.
        asyncio.create_task(asyncio.to_thread(
            _log_crm_interaction,
            nombre=nombre,
            telefono=self._caller_number,
            nota=f"Motivo: {motivo}." + (f" Sector/negocio: {sector}." if sector else ""),
        ))
        return "Registrado. Sigue la conversación con normalidad."

    @function_tool
    async def consultar_disponibilidad(
        self,
        context: RunContext,
        dia: Annotated[
            Literal["hoy", "manana", "lunes", "martes", "miercoles", "jueves", "viernes"],
            Field(description="El día que ha propuesto EL CLIENTE — pregúntaselo siempre primero ('¿qué día te vendría bien?'), nunca elijas tú un día ni ofrezcas una lista de días. Solo llama a esta herramienta cuando el cliente ya haya dicho un día concreto."),
        ],
        semana_que_viene: Annotated[
            bool,
            Field(description="True solo si el cliente ha dicho explícitamente 'la semana que viene' u otra forma de saltar a la semana siguiente junto con el día. False si no lo ha dicho (se busca el próximo de ese día, aunque caiga esta misma semana)."),
        ] = False,
        excluir_horas: Annotated[
            list[str],
            Field(description="Los valores [iso: ...] que ya le has ofrecido a este cliente EN ESTE MISMO DÍA y ha rechazado, para que la herramienta te dé un hueco distinto ese mismo día. Vacío la primera vez que preguntas por ese día."),
        ] = [],
    ) -> str:
        """Busca UN único hueco disponible en el día concreto que ha propuesto el
        cliente. Nunca la uses para ofrecer varios huecos o varios días de golpe:
        primero pregúntale qué día le viene bien, y llama a esta herramienta solo
        con ese día."""
        # _get_calendar_service() y _find_slots_on_day() hacen peticiones HTTP síncronas
        # a Google (construir el cliente y la consulta freebusy) — ejecutarlas directas
        # en el bucle de eventos de la llamada de voz congela TODO el audio (entrada y
        # salida) mientras esperan red, sonando como un silencio muerto. asyncio.to_thread
        # las manda a un hilo aparte para que la conversación siga fluida mientras tanto.
        service = await asyncio.to_thread(_get_calendar_service)
        if service is None:
            return "La agenda no está disponible ahora mismo. Ofrece que alguien del equipo le llame, o usa mostrar_calendario_en_pantalla."
        now = datetime.datetime.now(MADRID_TZ)
        target_date = _resolver_fecha_dia(now, dia, semana_que_viene)
        if target_date is None or target_date.weekday() >= 5:
            return "Ese día no es laborable (cae en fin de semana) o no se ha entendido bien. Pregunta al cliente por otro día, o usa mostrar_calendario_en_pantalla si prefiere elegir él mismo."
        try:
            slots = await asyncio.to_thread(_find_slots_on_day, service, target_date, excluir_horas=excluir_horas)
        except Exception:
            logger.exception("Error consultando disponibilidad")
            return "No se pudo consultar la agenda ahora mismo. Ofrece que alguien del equipo le llame."
        if not slots:
            return (
                "No quedan huecos libres ese día (o ya se los has ofrecido todos y los ha rechazado). "
                "Pregúntale si quiere probar otro día, o si prefiere que le muestres el calendario para "
                "elegir él mismo — en ese caso llama a mostrar_calendario_en_pantalla."
            )
        s = slots[0]
        # El hueco lleva su ISO exacto al lado del texto en español — al llamar a
        # reservar_cita hay que copiar ESE valor literal, nunca reconstruir la
        # fecha/hora de memoria a partir de lo dicho en voz alta (ahí es donde se
        # cuelan la mayoría de errores de reserva: el modelo calcula mal el día
        # o la zona horaria al convertir).
        return (
            f"Hueco disponible: {_formatear_fecha_es(s)} [iso: {s.isoformat()}]. Ofrécele SOLO este hueco "
            f"al cliente en voz alta, nunca leas el [iso: ...]. Si no le viene bien, vuelve a llamar a esta "
            f"misma herramienta con el mismo día y añade este iso a excluir_horas para que te dé otro "
            f"distinto ese mismo día. Si prefiere otro día, repite el proceso con el día nuevo que te diga."
        )

    @function_tool
    async def mostrar_calendario_en_pantalla(self, context: RunContext) -> str:
        """Llama a esta herramienta cuando, después de un par de intentos, no
        consigas cuadrar un hueco con el cliente por voz, o en cualquier momento
        en que el cliente prefiera elegir él mismo el día y la hora exactos. SOLO
        funciona si el cliente está en la web viendo el chat — si llama por
        teléfono no hay ninguna pantalla, así que en ese caso la herramienta
        misma te lo dice y NUNCA debes mencionar una pantalla ni un chat.
        Nunca dejes al cliente sin ninguna forma de reservar — usa esto como
        última opción antes de colgar sin cita, o pide directamente el día y la
        hora exacta que prefiera y llama a reservar_cita con lo que te diga."""
        if self._channel != "web":
            return (
                "Esta llamada es por TELÉFONO, no hay ninguna pantalla ni chat visible — "
                "NUNCA le digas que mire una pantalla ni que escriba por el chat de la web. "
                "En vez de eso, pregúntale directamente qué día y hora exacta prefiere (aunque "
                "sea fuera de los huecos que ya le has ofrecido) y llama a reservar_cita con eso, "
                "o dile que un miembro del equipo le llamará para cuadrar el hueco."
            )
        if self._room is None:
            return "No se pudo activar el calendario en pantalla. Dile que también puede reservar escribiendo por el chat de la web, o que alguien del equipo le llamará."
        try:
            payload = json.dumps({"type": "mostrar_calendario"}).encode("utf-8")
            await self._room.local_participant.publish_data(payload, reliable=True)
        except Exception:
            logger.exception("Error mandando la señal de mostrar calendario")
            return "No se pudo activar el calendario en pantalla. Dile que también puede reservar escribiendo por el chat de la web, o que alguien del equipo le llamará."
        return "Hecho. Dile al cliente que mire la pantalla — le ha aparecido un botón para elegir día y hora él mismo, sin compromiso."

    @function_tool
    async def reservar_cita(
        self,
        context: RunContext,
        fecha_hora_iso: Annotated[
            str,
            Field(description="El valor [iso: ...] EXACTO de ese hueco tal como lo devolvió consultar_disponibilidad — cópialo literal, no lo calcules ni lo reescribas a partir de la fecha en español que le dijiste al cliente."),
        ],
        nombre: Annotated[str, Field(description="Nombre del cliente")],
        llamar_al_mismo_numero: Annotated[
            bool,
            Field(description="True si el cliente ha dicho que le llamemos al mismo número desde el que está llamando. False si ha dado otro número (o si llama desde la web)."),
        ] = True,
        otro_telefono: Annotated[
            str,
            Field(description="El teléfono al que quiere que le llamemos, solo si es distinto del de la llamada o si llama desde la web. Vacío si es el mismo."),
        ] = "",
    ) -> str:
        """Confirma y crea la reserva de la consultoría gratuita en el hueco elegido.
        Solo hacen falta el hueco, el nombre y a qué teléfono llamarle; nunca pidas email."""
        telefono = otro_telefono.strip() if (otro_telefono.strip() or not llamar_al_mismo_numero) else (self._caller_number or "")
        if not telefono:
            return "Falta el teléfono al que llamarle. Pídeselo al cliente y vuelve a llamar a esta herramienta."
        # Igual que en consultar_disponibilidad: construir el servicio y crear el evento
        # son peticiones HTTP síncronas a Google — se mandan a un hilo aparte con
        # asyncio.to_thread para no congelar el audio de la llamada mientras esperan red.
        service = await asyncio.to_thread(_get_calendar_service)
        if service is None:
            return "No se pudo confirmar la reserva. Ofrece que alguien del equipo le llame."
        try:
            start = datetime.datetime.fromisoformat(fecha_hora_iso)
            end = start + datetime.timedelta(minutes=SLOT_MINUTES)

            def _crear_evento():
                service.events().insert(
                    calendarId=CALENDAR_ID,
                    body={
                        "summary": f"Consultoría gratuita TRUCO — {nombre}",
                        "description": f"Reservada por llamada de voz.\nLlamar al: {telefono}",
                        "start": {"dateTime": start.isoformat(), "timeZone": "Europe/Madrid"},
                        "end": {"dateTime": end.isoformat(), "timeZone": "Europe/Madrid"},
                    },
                ).execute()

            await asyncio.to_thread(_crear_evento)
        except Exception:
            logger.exception("Error creando la reserva")
            return "No se pudo confirmar la reserva. Ofrece que alguien del equipo le llame."
        self._state["nombre"] = nombre
        self._state["booked"] = True
        self._state["end_reason"] = "cita_agendada"
        self._state["hangup_after_ts"] = datetime.datetime.now(datetime.timezone.utc).timestamp()
        asyncio.create_task(asyncio.to_thread(
            _log_crm_interaction,
            nombre=nombre,
            telefono=telefono,
            nota=f"Reservó consultoría por voz para el {_formatear_fecha_es(start)}. Llamar al {telefono}.",
        ))
        mismo = "a este mismo número" if (llamar_al_mismo_numero and not otro_telefono.strip()) else "al número que me has dado"
        return (
            f"Reserva confirmada para {nombre} el {_formatear_fecha_es(start)}. AHORA despídete en UNA sola intervención breve y cálida: "
            f"resume que la cita queda anotada para ese día y hora, que le llamaremos {mismo}, da las gracias por llamar y desea un buen día. "
            f"No hagas ninguna pregunta ni añadas nada más: la llamada se cierra sola justo después."
        )


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: agents.JobContext):
    session = AgentSession(
        llm=google.realtime.RealtimeModel(
            model="gemini-2.5-flash-native-audio-preview-12-2025",
            voice="Achird",
            enable_affective_dialog=True,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    silence_duration_ms=300,
                    prefix_padding_ms=20,
                    # Con ruido de fondo, el detector por defecto tarda en darse
                    # cuenta de que alguien ha empezado a hablar (o directamente
                    # no lo detecta) — alta sensibilidad de inicio hace que
                    # reaccione antes a la voz real aunque haya ruido de por
                    # medio. Baja sensibilidad de fin evita que un hueco breve
                    # entre ruido corte al cliente a mitad de frase.
                    start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_HIGH,
                    end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_LOW,
                )
            ),
        ),
    )

    live_pricing_block = _fetch_live_pricing_block()

    await ctx.connect()
    participant = await ctx.wait_for_participant()
    is_phone = participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP
    raw_number = (participant.attributes.get("sip.phoneNumber") or "").strip() if is_phone else ""
    hidden = is_phone and (not raw_number or raw_number.lower() in ("anonymous", "unknown"))
    caller_number = raw_number if (is_phone and not hidden) else None
    channel = "phone" if is_phone else "web"

    allowed, blocked = True, False
    if is_phone:
        key = caller_number or "oculto"
        limit = MAX_CALLS_PER_NUMBER_MONTH if caller_number else MAX_CALLS_HIDDEN_NUMBER_MONTH
        allowed, blocked = await asyncio.to_thread(_voice_gate, key, limit)

    call_id = await asyncio.to_thread(_voice_call_create, ctx.room.name, channel, caller_number)
    started = datetime.datetime.now(datetime.timezone.utc)
    state = {"nombre": None, "booked": False, "end_reason": "cliente_colgo"}
    transcript = []

    PHONE_NO_SCREEN = (
        " ESTO ES UNA LLAMADA DE TELÉFONO, no hay pantalla ni chat visible: nunca digas cosas como "
        "\"te dejo un calendario en la pantalla\", \"mira el chat de la web\" ni \"puedes verlo tú mismo\" — "
        "quien te llama solo te oye. Si no cuadráis un hueco por voz, pregúntale directamente qué día y hora "
        "exacta prefiere y llama a reservar_cita, o dile que un miembro del equipo le llamará para cerrarlo."
    )
    if channel == "phone":
        if caller_number:
            call_block = (
                f"DATOS DE ESTA LLAMADA: llama desde un teléfono, número {caller_number} (ya lo tienes, no se lo pidas "
                "ni lo leas entero en voz alta). La llamada dura como máximo unos 5 minutos." + PHONE_NO_SCREEN
            )
        else:
            call_block = (
                "DATOS DE ESTA LLAMADA: llama desde un teléfono con el número oculto, así que NO tienes su número. "
                "Si quiere reservar cita, pídele el teléfono al que llamarle. La llamada dura como máximo unos 5 minutos." + PHONE_NO_SCREEN
            )
    else:
        call_block = (
            "DATOS DE ESTA LLAMADA: llama desde la web, no tienes su número de teléfono. Si quiere reservar cita, "
            "pídele el teléfono al que llamarle. La conversación dura como máximo unos 5 minutos."
        )

    agent = TrucoAgent(
        room=ctx.room,
        instructions=call_block + "\n\n" + live_pricing_block + "\n\n" + SYSTEM_INSTRUCTIONS,
        caller_number=caller_number,
        call_state=state,
        channel=channel,
    )

    @session.on("conversation_item_added")
    def _on_item(ev):
        item = ev.item
        role = getattr(item, "role", None)
        text = getattr(item, "text_content", None)
        if role in ("user", "assistant") and text:
            transcript.append({"role": role, "text": text, "t": datetime.datetime.now(datetime.timezone.utc).isoformat()})
            hang_ts = state.get("hangup_after_ts")
            if role == "assistant" and hang_ts and not state.get("hangup_scheduled") and getattr(ev, "created_at", 0) >= hang_ts:
                state["hangup_scheduled"] = True
                delay = min(14.0, 3.0 + len(text) * 0.07)

                async def _colgar():
                    await asyncio.sleep(delay)
                    await ctx.delete_room()

                asyncio.create_task(_colgar())
            asyncio.get_running_loop().run_in_executor(
                None, _voice_call_update, call_id, {"transcript": list(transcript), "nombre": state.get("nombre")}
            )

    async def _on_shutdown():
        ended = datetime.datetime.now(datetime.timezone.utc)
        await asyncio.to_thread(_voice_call_update, call_id, {
            "ended_at": ended.isoformat(),
            "duration_s": int((ended - started).total_seconds()),
            "nombre": state.get("nombre"),
            "booked": bool(state.get("booked")),
            "end_reason": state.get("end_reason"),
            "transcript": transcript,
        })

    ctx.add_shutdown_callback(_on_shutdown)

    await session.start(room=ctx.room, agent=agent)

    # Sonido de ambiente de fondo (oficina, muy bajo) durante toda la llamada,
    # más un sonido de "pensando" (tecleo) que suena SOLO mientras el agente
    # está procesando una respuesta o esperando una herramienta — llena el
    # hueco de silencio que antes sonaba a llamada cortada, sin depender de
    # que el modelo acierte siempre con una muletilla hablada.
    background_audio = BackgroundAudioPlayer(
        ambient_sound=AudioConfig(BuiltinAudioClip.OFFICE_AMBIENCE, volume=0.3),
        thinking_sound=[
            AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING, volume=0.6),
            AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING2, volume=0.5),
        ],
    )
    await background_audio.start(room=ctx.room, agent_session=session)

    if not allowed:
        state["end_reason"] = "bloqueado" if blocked else "tope_mensual"
        if blocked:
            msg = "Dile en una frase, con educación, que este servicio no está disponible para este número, y despídete."
        else:
            msg = (
                "Dile amablemente, en una o dos frases, que desde este número ya se han hecho las llamadas gratuitas de este mes al asistente, "
                "que puede escribir por el chat de la web trucotechnology.com o volver a llamar el mes que viene, y despídete."
            )
        h = session.generate_reply(instructions=msg)
        try:
            await h.wait_for_playout()
        except Exception:
            pass
        await asyncio.sleep(1)
        await ctx.delete_room()
        return

    async def _limit_watch():
        await asyncio.sleep(CALL_WARN_SECONDS)
        session.generate_reply(
            instructions="Avisa con naturalidad de que queda poco más de medio minuto de llamada y, si no ha reservado, ofrécele cerrar ya la cita o que escriba por el chat de la web."
        )
        await asyncio.sleep(CALL_MAX_SECONDS - CALL_WARN_SECONDS)
        state["end_reason"] = "limite_5min"
        h = session.generate_reply(instructions="Despídete amablemente en una frase: se acaba el tiempo de la llamada, puede escribir por el chat de la web o volver a llamar.")
        try:
            await h.wait_for_playout()
        except Exception:
            pass
        await asyncio.sleep(1)
        await ctx.delete_room()

    limit_task = asyncio.create_task(_limit_watch())

    async def _cancel_limit():
        limit_task.cancel()

    ctx.add_shutdown_callback(_cancel_limit)

    await session.generate_reply(
        instructions="Saluda brevemente en español y, en la primera frase, di con claridad que eres el asistente virtual de TRUCO technology y que la conversación se transcribe para atenderle mejor. Después pregunta el nombre de quien llama, antes de nada más."
    )


if __name__ == "__main__":
    agents.cli.run_app(server)

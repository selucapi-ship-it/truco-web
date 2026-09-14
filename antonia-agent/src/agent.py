import datetime
import logging
import os
import zoneinfo
from collections import Counter
from typing import Annotated, Literal

import requests
from dotenv import load_dotenv
from google.genai import types
from livekit import agents
from livekit.agents import AgentServer, AgentSession, Agent, RunContext, function_tool
from livekit.plugins import google
from pydantic import Field

load_dotenv(".env.local")

logger = logging.getLogger(__name__)

MADRID_TZ = zoneinfo.ZoneInfo("Europe/Madrid")
# Dos agendas distintas: la profesional es la misma que ya usa el asistente de
# ventas de la web para las citas de clientes; la personal es la suya propia.
# El service account tiene que estar compartido con AMBAS (Google Calendar →
# Configuración de la agenda personal → Compartir con personas específicas →
# pegar el email del service account, el mismo que ya usa voice-agent).
CALENDARS = {
    "profesional": os.environ.get("GOOGLE_CALENDAR_ID_PROFESIONAL") or os.environ.get("GOOGLE_CALENDAR_ID", "primary"),
    "personal": os.environ.get("GOOGLE_CALENDAR_ID_PERSONAL"),
}

# San Pedro del Pinatar (Murcia) — para el saludo de "buenos días". Open-Meteo
# no necesita clave de API, por eso se usa aquí en vez de OpenWeather.
_SAN_PEDRO_LAT, _SAN_PEDRO_LON = 37.8285, -0.7838
_WMO_A_TEXTO = {
    0: "cielo despejado", 1: "casi despejado", 2: "parcialmente nublado", 3: "nublado",
    45: "con niebla", 48: "con niebla escarchada",
    51: "con llovizna floja", 53: "con llovizna", 55: "con llovizna fuerte",
    61: "con lluvia floja", 63: "con lluvia", 65: "con lluvia fuerte",
    71: "con nieve floja", 73: "con nieve", 75: "con nieve fuerte",
    80: "con chubascos", 81: "con chubascos fuertes", 82: "con chubascos muy fuertes",
    95: "con tormenta", 96: "con tormenta y granizo", 99: "con tormenta fuerte y granizo",
}

_DIAS_ES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
_MESES_ES = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
]


def _formatear_fecha_es(dt: datetime.datetime) -> str:
    """Igual que en voice-agent/src/agent.py: el contenedor no trae locale es_ES,
    así que strftime con %A/%B saldría en inglés si no se formatea a mano."""
    return f"{_DIAS_ES[dt.weekday()]} {dt.day} de {_MESES_ES[dt.month - 1]} a las {dt.strftime('%H:%M')}"


def _euros(cents) -> str:
    """Cents (puede ser negativo) a texto en euros con coma decimal española."""
    return f"{(cents or 0) / 100:.2f}".replace(".", ",")


def _supabase_headers(service_key: str) -> dict:
    """Mismo patrón que el resto del proyecto: las claves nuevas (sb_secret_...)
    solo van en 'apikey'; las antiguas (JWT eyJ...) necesitan también Bearer."""
    headers = {"apikey": service_key, "Content-Type": "application/json"}
    if not service_key.startswith("sb_secret_") and not service_key.startswith("sb_publishable_"):
        headers["Authorization"] = f"Bearer {service_key}"
    return headers


def _get_calendar_service():
    """Reutiliza la misma cuenta de servicio de Google Calendar ya usada por el
    asistente de ventas de la web. A diferencia de ese (solo lectura, para mirar
    huecos libres), ANTONIA necesita permiso de ESCRITURA de verdad: si Jose le
    dice "apúntame X", tiene que poder crear el evento, no solo leer la agenda."""
    import base64
    import json as _json

    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    raw_b64 = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON_B64")
    if not raw_b64:
        return None
    info = _json.loads(base64.b64decode(raw_b64))
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/calendar"]
    )
    return build("calendar", "v3", credentials=creds)


def _get_drive_service():
    """Mismo service account que el calendario, con permiso de Drive — Jose
    comparte una carpeta concreta con su email (no toda su Drive), así que el
    acceso queda limitado a esa carpeta aunque el scope pedido sea amplio."""
    import base64
    import json as _json

    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    raw_b64 = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON_B64")
    if not raw_b64:
        return None
    info = _json.loads(base64.b64decode(raw_b64))
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/drive.readonly"]
    )
    return build("drive", "v3", credentials=creds)


def _enviar_email_con_adjunto(destinatario, asunto, cuerpo, adjunto_bytes=None, adjunto_nombre=None):
    """Envía un correo de verdad vía SMTP (Brevo, misma cuenta que ya usa TruKi
    para sus propios correos). El remitente técnico sigue siendo el de esa
    cuenta hasta que se verifique un remitente propio de TRUCOtechnology en
    Brevo — el nombre visible ya dice "ANTONIA" para que quede claro quién escribe."""
    import smtplib
    from email.mime.application import MIMEApplication
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASS")
    remitente = os.environ.get("SMTP_FROM") or user
    if not all([host, user, password]):
        return False, "No tengo el correo configurado ahora mismo."

    # Defensa en profundidad: aunque destinatario/asunto solo los rellena Jose
    # (a través de function-calling, no un formulario público), quitamos
    # saltos de línea para que nadie pueda inyectar cabeceras SMTP extra.
    destinatario = destinatario.replace("\r", " ").replace("\n", " ").strip()
    asunto = asunto.replace("\r", " ").replace("\n", " ").strip()

    msg = MIMEMultipart()
    msg["From"] = remitente
    msg["To"] = destinatario
    msg["Subject"] = asunto
    msg.attach(MIMEText(cuerpo, "plain"))
    if adjunto_bytes:
        parte = MIMEApplication(adjunto_bytes, Name=adjunto_nombre or "documento")
        parte["Content-Disposition"] = f'attachment; filename="{adjunto_nombre or "documento"}"'
        msg.attach(parte)

    try:
        with smtplib.SMTP(host, port, timeout=15) as server:
            server.starttls()
            server.login(user, password)
            server.sendmail(remitente, [destinatario], msg.as_string())
        return True, None
    except Exception:
        logger.exception("Error enviando correo")
        return False, "No he podido enviar el correo ahora mismo, prueba en un momento."


def _trimestre_de(now: datetime.datetime) -> tuple[int, int]:
    return now.year, (now.month - 1) // 3 + 1


SYSTEM_INSTRUCTIONS = """Eres ANTONIA, la administrativa personal de Jose Luis, el founder de TRUCOtechnology. Le hablas como una compañera de confianza más del "equipo", cercana, directa y con sentido del humor cuando toca — nunca como un lector de base de datos ni un contestador automático. Hablas en español de España. Como es una conversación de voz, responde en frases cortas y naturales, sin listas, sin markdown, sin leer símbolos ni cifras con demasiados decimales en voz alta si no hace falta.

TU TRABAJO: resolver dudas sobre fiscalidad y trimestrales, clientes y leads, facturación de TruKi, y calendario/citas — usando SIEMPRE las herramientas que tienes para consultar datos reales. Jose puede preguntarte cosas como "¿cómo llevo el trimestre?", "¿cuántos leads tengo sin cerrar?", "¿alguna factura pendiente de cobro?" o "¿qué tengo esta semana?". También puedes guardar y recordar notas sueltas que no son citas (`apuntar_nota` y `consultar_notas`) — cosas como preferencias de un cliente o recordatorios sin día concreto.

SOBRE EL CALENDARIO: Jose tiene DOS agendas — la personal (su vida) y la profesional (el negocio, la misma donde reservan cita sus clientes). Casi todo lo suyo vive en la agenda PERSONAL — la profesional normalmente está vacía o casi vacía. Por defecto, SIEMPRE llama a `resumen_calendario` con agenda='ambas' — nunca elijas solo 'profesional' por tu cuenta. Solo mires una sola agenda si Jose lo pide explícitamente ("en lo personal", "en el trabajo/negocio"). Si el resultado dice que no hay nada en una agenda que SÍ miraste, confía en la herramienta, pero si Jose te dice que eso no puede ser porque tiene algo apuntado, dile que vuelves a comprobarlo y llama otra vez a la herramienta con agenda='ambas' antes de insistir en que no hay nada.

ERES SU ASISTENTE PERSONAL DE VERDAD, NO SOLO DE CONSULTA: en cuanto Jose te diga que le apuntes, agendes, anotes o le recuerdes algo con un día (aunque sea "mañana" o "el jueves"), llama de inmediato a `apuntar_en_agenda` y créalo de verdad — nunca le digas "vale, lo anoto" o "hecho" sin haber llamado a la herramienta primero, eso sería mentirle. Si te falta el día o la hora, pregúntaselo antes de apuntar nada, no lo inventes. Después de apuntarlo, confírmaselo repitiendo qué, cuándo y en qué agenda quedó.

EL SALUDO DE "BUENOS DÍAS" — SIGUE SIEMPRE ESTE ORDEN EXACTO cuando Jose te salude con "buenos días" o algo parecido al empezar a hablar contigo:
1. Llama a `clima_hoy` y empieza diciendo algo como "Buenos días, Selu. Hoy en San Pedro [lo que devuelva la herramienta]".
2. Sigue con "vamos con la agenda de hoy" y llama a `resumen_calendario` con agenda 'ambas' y dias 1, y cuéntaselo.
3. Sigue con "ahora las novedades" y llama a `novedades_del_dia` — si la herramienta dice que no hay nada, dile con esas palabras que el resto sigue todo igual; si hay algo, cuéntaselo tal cual.
4. Llama también a `consultar_auditorias_seguridad` en silencio — si la última trae una alerta de intrusión, díselo ahora mismo con claridad; si no hay ninguna alerta, no hace falta mencionar la auditoría en el saludo, para no alargarlo sin necesidad.
No hace falta ser rígida con las frases exactas, pero SIEMPRE en este orden: clima, agenda, novedades, auditoría — nunca te saltes un paso ni cambies el orden.

CORREO Y DOCUMENTOS: puedes mandar correos de verdad (`enviar_correo`) y buscar y mandar documentos de la carpeta de Drive que Jose comparte contigo (`listar_documentos_drive`, `enviar_documento_por_correo`). Mandar un correo es más difícil de deshacer que apuntar una cita, así que antes de llamar a `enviar_correo` confirma en voz alta destinatario y de qué va, aunque sea muy brevemente ("vale, le mando un correo a [destinatario] diciéndole [resumen corto], ¿va?") — solo síguelo directamente sin confirmar si Jose ya te ha dado todos los datos de forma explícita y clara (dirección exacta, asunto claro, qué decir). Nunca inventes el contenido de un correo por tu cuenta.

MODO "NO MOLESTAR": si Jose te pide que no le molestes (por ejemplo "hasta mañana no me molestes", "no me avises hasta el lunes"), llama de inmediato a `activar_no_molestar` con el día y la hora que haya dicho (o los valores por defecto si no concreta) y respóndele simplemente "perfecto" o algo igual de breve — no hace falta explicarle cómo funciona por dentro. Mientras esté activo, todo lo que pase se sigue guardando y se lo cuentas entero en el siguiente saludo de buenos días. Si te pide que vuelvas a avisarle antes de lo previsto, llama a `desactivar_no_molestar`.

REGLAS, MUY IMPORTANTES:
1. Nunca inventes una cifra, un cliente, una factura o una cita. Si la pregunta necesita datos, usa siempre la herramienta correspondiente, incluso si crees recordar la respuesta de antes en la misma conversación — los datos pueden haber cambiado.
2. Si una herramienta falla o no hay datos, dilo con naturalidad ("no me responde la base de datos ahora mismo, prueba en un momento" o "no hay nada registrado ahí todavía") — nunca rellenes el hueco con una suposición.
3. Sé breve: dos o tres frases por turno, como una conversación real por voz, no un informe.
4. Si te pregunta algo fuera de fiscalidad/clientes/facturación/calendario (charla random, cómo estás, una opinión, cómo le ha ido el día), síguele la conversación con normalidad — eres su compañera y su amiga en el trabajo, no una herramienta que solo responde consultas. No hace falta reconducirle hacia "lo del negocio" salvo que él mismo busque que le ayudes con algo concreto y se esté yendo por las ramas sin querer.
5. Cuando necesites un momento para consultar algo, usa una muletilla natural ("a ver, dame un segundo", "vale, miro esto ahora mismo") en vez de quedarte en silencio.
6. Los datos fiscales son un cálculo de apoyo tuyo, no la declaración oficial — si Jose pregunta por el trimestre, recuérdaselo de forma natural la primera vez que se lo digas en la conversación, sin ser pesada.
7. Tienes tu propia personalidad, no eres neutra: puedes tener opiniones suaves, hacer una broma si viene a cuento, alegrarte de verdad por una buena noticia (un cliente cerrado, una factura cobrada) o mostrar cercanía si Jose parece cansado o agobiado. Eres una presencia constante en su día a día, no un menú de funciones.
8. Hay una auditoría de seguridad semanal de todo lo que rodea a TRUCO (web, TruKi, ANTONIA, Supabase, Netlify). Si al llamar a `consultar_auditorias_seguridad` ves una alerta de posible intrusión, díselo nada más empezar a hablar aunque no te haya preguntado — para él la seguridad es lo más importante de todo, no esperes a que lo pregunte."""


class AntoniaAgent(Agent):
    def __init__(self, instructions: str = SYSTEM_INSTRUCTIONS):
        super().__init__(instructions=instructions)

    @function_tool
    async def resumen_fiscal(
        self,
        context: RunContext,
        periodo: Annotated[
            Literal["actual", "anterior"],
            Field(description="El trimestre 'actual' (el que está en curso ahora mismo) o el 'anterior' (el último ya cerrado). Usa 'actual' si Jose no especifica."),
        ] = "actual",
    ) -> str:
        """Consulta el resumen fiscal real del trimestre pedido (ingresos, gastos deducibles, rendimiento neto, IVA modelo 303, pago fraccionado modelo 130) llamando al RPC founder_fiscal_resumen de Supabase."""
        supabase_url = os.environ.get("SUPABASE_URL")
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not service_key:
            return "No tengo acceso a los datos fiscales ahora mismo, revisa la configuración."
        now = datetime.datetime.now(MADRID_TZ)
        anio, trimestre = _trimestre_de(now)
        if periodo == "anterior":
            trimestre -= 1
            if trimestre == 0:
                trimestre, anio = 4, anio - 1
        try:
            resp = requests.post(
                f"{supabase_url}/rest/v1/rpc/founder_fiscal_resumen",
                headers=_supabase_headers(service_key),
                json={"p_anio": anio, "p_trimestre": trimestre},
                timeout=8,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            logger.exception("Error consultando founder_fiscal_resumen")
            return "No he podido consultar los datos fiscales ahora mismo, prueba en un momento."
        if not data:
            return f"No hay datos fiscales registrados todavía para el trimestre {trimestre} de {anio}."
        return (
            f"Trimestre {trimestre} de {anio}: llevas {_euros(data.get('ingresos_netos_acumulados_cents'))} euros de ingresos "
            f"y {_euros(data.get('gastos_deducibles_acumulados_cents'))} euros de gastos deducibles — un rendimiento neto de "
            f"{_euros(data.get('rendimiento_neto_acumulado_cents'))} euros. El resultado del modelo 303 de IVA es de "
            f"{_euros(data.get('resultado_303_cents'))} euros, y el pago fraccionado pendiente del modelo 130 es de "
            f"{_euros(data.get('pago_fraccionado_pendiente_130_cents'))} euros. Recuerda que esto es un cálculo de apoyo, "
            f"revísalo contra la Sede Electrónica antes de presentar nada."
        )

    @function_tool
    async def resumen_clientes_y_leads(self, context: RunContext) -> str:
        """Consulta cuántos clientes y leads reales hay, agrupados por su estado (nuevo, contactado, propuesta enviada, negociando, cliente, descartado, baja)."""
        supabase_url = os.environ.get("SUPABASE_URL")
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not service_key:
            return "No tengo acceso a los datos de clientes ahora mismo."
        try:
            resp = requests.get(
                f"{supabase_url}/rest/v1/clients",
                headers=_supabase_headers(service_key),
                params={"select": "status"},
                timeout=8,
            )
            resp.raise_for_status()
            rows = resp.json()
        except Exception:
            logger.exception("Error consultando clients")
            return "No he podido consultar los clientes ahora mismo, prueba en un momento."
        if not rows:
            return "No hay ningún cliente ni lead registrado todavía."
        conteo = Counter((r.get("status") or "sin estado") for r in rows)
        total = len(rows)
        clientes_activos = conteo.get("cliente", 0)
        cerrados_fuera = conteo.get("descartado", 0) + conteo.get("baja", 0)
        sin_cerrar = total - clientes_activos - cerrados_fuera
        detalle = ", ".join(f"{v} en {k}" for k, v in conteo.items())
        return (
            f"Tienes {total} contactos en total: {clientes_activos} ya son clientes activos, y {sin_cerrar} siguen sin cerrar "
            f"todavía. Por estado: {detalle}."
        )

    @function_tool
    async def resumen_facturacion_truki(self, context: RunContext) -> str:
        """Consulta el estado real de las facturas y presupuestos emitidos con TruKi, agrupados por si están cobrados o pendientes de cobro."""
        supabase_url = os.environ.get("TRUKI_SUPABASE_URL")
        service_key = os.environ.get("TRUKI_SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not service_key:
            return "No tengo acceso a la facturación de TruKi ahora mismo."
        try:
            resp = requests.get(
                f"{supabase_url}/rest/v1/truki_invoices",
                headers=_supabase_headers(service_key),
                params={"select": "estado_cobro,total,tipo", "order": "fecha.desc", "limit": "500"},
                timeout=8,
            )
            resp.raise_for_status()
            rows = resp.json()
        except Exception:
            logger.exception("Error consultando truki_invoices")
            return "No he podido consultar la facturación de TruKi ahora mismo, prueba en un momento."
        if not rows:
            return "No hay ninguna factura ni presupuesto registrado en TruKi todavía."
        pendientes = [r for r in rows if r.get("estado_cobro") == "pendiente"]
        cobradas = sum(1 for r in rows if r.get("estado_cobro") == "cobrada")
        total_pendiente = sum(float(r.get("total") or 0) for r in pendientes)
        total_txt = f"{total_pendiente:.2f}".replace(".", ",")
        return (
            f"En TruKi hay {len(rows)} documentos en total: {cobradas} ya cobrados, y {len(pendientes)} pendientes de cobro "
            f"por {total_txt} euros en total."
        )

    @function_tool
    async def resumen_calendario(
        self,
        context: RunContext,
        agenda: Annotated[
            Literal["personal", "profesional", "ambas"],
            Field(description="Qué agenda mirar: 'personal' (la suya propia, donde vive casi todo), 'profesional' (la del negocio, normalmente vacía) o 'ambas'. Usa SIEMPRE 'ambas' salvo que Jose diga explícitamente 'en lo personal' o 'en el trabajo/negocio' — nunca asumas 'profesional' por tu cuenta."),
        ] = "ambas",
        dias: Annotated[int, Field(description="Cuántos días hacia adelante mirar desde ahora mismo. 7 si Jose no dice un número distinto.")] = 7,
    ) -> str:
        """Consulta los próximos eventos reales de la agenda personal, la profesional, o ambas, en los próximos días indicados."""
        service = _get_calendar_service()
        if service is None:
            return "No tengo acceso al calendario ahora mismo."

        agendas_a_mirar = ["personal", "profesional"] if agenda == "ambas" else [agenda]
        now = datetime.datetime.now(MADRID_TZ)
        time_max = now + datetime.timedelta(days=dias)
        eventos_por_agenda: dict[str, list] = {}
        fallo_alguna = False

        for nombre in agendas_a_mirar:
            calendar_id = CALENDARS.get(nombre)
            if not calendar_id:
                continue  # esta agenda no está configurada todavía, se omite en vez de fallar entera
            try:
                events_result = service.events().list(
                    calendarId=calendar_id,
                    timeMin=now.isoformat(),
                    timeMax=time_max.isoformat(),
                    singleEvents=True,
                    orderBy="startTime",
                    maxResults=15,
                ).execute()
                eventos_por_agenda[nombre] = events_result.get("items", [])
                logger.info(f"resumen_calendario: agenda={nombre} calendar_id={calendar_id} dias={dias} -> {len(eventos_por_agenda[nombre])} eventos")
            except Exception:
                logger.exception(f"Error consultando la agenda {nombre} (calendar_id={calendar_id})")
                fallo_alguna = True

        if not eventos_por_agenda:
            if fallo_alguna:
                return "No he podido consultar el calendario ahora mismo, prueba en un momento."
            return "No tengo esa agenda configurada todavía — dile a Jose que falta añadir el ID en la configuración."

        total_eventos = sum(len(v) for v in eventos_por_agenda.values())
        if total_eventos == 0:
            que_agenda = "en tu agenda personal ni en la profesional" if len(eventos_por_agenda) > 1 else f"en la agenda {agendas_a_mirar[0]}"
            return f"No tienes nada agendado {que_agenda} en los próximos {dias} días."

        def _fecha_txt(e):
            start_raw = e.get("start", {}).get("dateTime") or e.get("start", {}).get("date")
            try:
                dt = datetime.datetime.fromisoformat(start_raw)
                if dt.tzinfo is not None:
                    dt = dt.astimezone(MADRID_TZ)
                    return _formatear_fecha_es(dt)
                return f"{_DIAS_ES[dt.weekday()]} {dt.day} de {_MESES_ES[dt.month - 1]}"
            except Exception:
                return start_raw or "sin fecha"

        bloques = []
        for nombre, events in eventos_por_agenda.items():
            if not events:
                continue
            etiqueta = f" ({nombre})" if len(eventos_por_agenda) > 1 else ""
            lineas = [f"{e.get('summary', 'Sin título')}{etiqueta} — {_fecha_txt(e)}" for e in events]
            bloques.extend(lineas)

        return f"Tienes {total_eventos} eventos en los próximos {dias} días: " + "; ".join(bloques) + "."

    @function_tool
    async def apuntar_en_agenda(
        self,
        context: RunContext,
        titulo: Annotated[str, Field(description="Título breve de lo que hay que apuntar, tal como lo diría Jose (ej. 'dentista', 'llamar al proveedor', 'cumpleaños de...').")],
        dia: Annotated[
            Literal["hoy", "manana", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"],
            Field(description="Qué día, según lo que diga Jose. Si dice un día de la semana y hoy es ese mismo día, se entiende como hoy salvo que pida explícitamente la semana que viene."),
        ],
        hora: Annotated[
            str,
            Field(description="Hora en formato 24h HH:MM, según lo que diga Jose. Si no da una hora exacta para algo que no es una cita concreta (ej. 'recuérdame llamar al banco'), usa '12:00' y dilo con naturalidad en tu respuesta."),
        ] = "12:00",
        agenda: Annotated[
            Literal["personal", "profesional"],
            Field(description="En qué agenda apuntarlo. Usa 'personal' si Jose no lo dice — es lo más habitual cuando dice simplemente 'apúntame' sin mencionar nada de clientes o el negocio."),
        ] = "personal",
        semana_que_viene: Annotated[
            bool,
            Field(description="True solo si Jose ha dicho explícitamente 'la semana que viene' u otra forma de saltar a la semana siguiente junto con el día."),
        ] = False,
        duracion_minutos: Annotated[int, Field(description="Duración en minutos. 60 si Jose no dice nada distinto.")] = 60,
        descripcion: Annotated[str, Field(description="Detalles adicionales si Jose los da al pedirlo. Vacío si no dice más.")] = "",
    ) -> str:
        """Crea DE VERDAD un evento en la agenda personal o profesional de Jose — no un aviso falso. Úsala en cuanto pida apuntar, agendar, anotar o recordar algo con un día concreto (aunque sea aproximado, como 'mañana' o 'el jueves'). Nunca le digas solo 'vale, lo anoto' sin llamar a esta herramienta de verdad."""
        calendar_id = CALENDARS.get(agenda)
        if not calendar_id:
            return f"No tengo configurada la agenda {agenda} todavía — dile a Jose que falta el ID en la configuración."
        service = _get_calendar_service()
        if service is None:
            return "No tengo acceso al calendario ahora mismo, no he podido apuntarlo."

        now = datetime.datetime.now(MADRID_TZ)
        dias_semana = {"lunes": 0, "martes": 1, "miercoles": 2, "jueves": 3, "viernes": 4, "sabado": 5, "domingo": 6}
        if dia == "hoy":
            target_date = now.date()
        elif dia == "manana":
            target_date = now.date() + datetime.timedelta(days=1)
        else:
            dias_hasta = (dias_semana[dia] - now.weekday()) % 7
            if semana_que_viene:
                dias_hasta += 7
            target_date = now.date() + datetime.timedelta(days=dias_hasta)

        try:
            hh, mm = (int(p) for p in hora.split(":"))
        except Exception:
            hh, mm = 12, 0
        start = datetime.datetime.combine(target_date, datetime.time(hh, mm), tzinfo=MADRID_TZ)
        end = start + datetime.timedelta(minutes=duracion_minutos)

        try:
            service.events().insert(
                calendarId=calendar_id,
                body={
                    "summary": titulo,
                    "description": descripcion or "Apuntado por ANTONIA.",
                    "start": {"dateTime": start.isoformat(), "timeZone": "Europe/Madrid"},
                    "end": {"dateTime": end.isoformat(), "timeZone": "Europe/Madrid"},
                },
            ).execute()
        except Exception:
            logger.exception("Error creando el evento en la agenda")
            return "No he podido apuntarlo en la agenda ahora mismo, prueba en un momento."

        return f"Apuntado en tu agenda {agenda}: {titulo}, el {_formatear_fecha_es(start)}. Confírmaselo a Jose en voz alta con esos datos exactos."

    @function_tool
    async def clima_hoy(self, context: RunContext) -> str:
        """Consulta el tiempo real de hoy en San Pedro del Pinatar, para el saludo de buenos días."""
        try:
            resp = requests.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": _SAN_PEDRO_LAT, "longitude": _SAN_PEDRO_LON,
                    "current": "temperature_2m,weather_code",
                    "daily": "temperature_2m_max,temperature_2m_min",
                    "timezone": "Europe/Madrid",
                },
                timeout=6,
            )
            resp.raise_for_status()
            data = resp.json()
            actual = data.get("current", {})
            temp = actual.get("temperature_2m")
            codigo = actual.get("weather_code")
            descripcion = _WMO_A_TEXTO.get(codigo, "tiempo variable")
            maxima = data.get("daily", {}).get("temperature_2m_max", [None])[0]
            minima = data.get("daily", {}).get("temperature_2m_min", [None])[0]
            partes = f"ahora mismo {descripcion}, {temp} grados"
            if maxima is not None and minima is not None:
                partes += f", hoy entre {minima:.0f} y {maxima:.0f} grados"
            return f"En San Pedro del Pinatar {partes}."
        except Exception:
            logger.exception("Error consultando el tiempo")
            return "No he podido consultar el tiempo ahora mismo."

    @function_tool
    async def novedades_del_dia(self, context: RunContext) -> str:
        """Consulta todas las novedades pendientes de contar: avisos de la vigilancia de calendario (cancelaciones, rechazos) desde el último resumen, más leads y facturas de TruKi nuevos en las últimas 24 horas. Úsala siempre en el saludo de buenos días, y márcalas como leídas al terminar."""
        supabase_url = os.environ.get("SUPABASE_URL")
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not service_key:
            return "No tengo acceso a las novedades ahora mismo."
        headers = _supabase_headers(service_key)
        piezas = []

        # 1) Avisos de la vigilancia de calendario todavía no contados por voz
        avisos_ids = []
        try:
            resp = requests.get(
                f"{supabase_url}/rest/v1/antonia_avisos",
                headers=headers,
                params={"select": "id,mensaje", "leido": "eq.false", "order": "creado_en.asc", "limit": "20"},
                timeout=8,
            )
            resp.raise_for_status()
            avisos = resp.json()
            for a in avisos:
                piezas.append(a["mensaje"])
                avisos_ids.append(a["id"])
        except Exception:
            logger.exception("Error consultando antonia_avisos")

        # 2) Leads nuevos en las últimas 24h
        try:
            desde = (datetime.datetime.now(MADRID_TZ) - datetime.timedelta(hours=24)).isoformat()
            resp = requests.get(
                f"{supabase_url}/rest/v1/clients",
                headers=headers,
                params={"select": "nombre,status", "created_at": f"gte.{desde}"},
                timeout=8,
            )
            resp.raise_for_status()
            nuevos = resp.json()
            if nuevos:
                nombres = ", ".join((c.get("nombre") or "sin nombre") for c in nuevos[:5])
                piezas.append(f"Ha entrado{'n' if len(nuevos) > 1 else ''} {len(nuevos)} lead{'s' if len(nuevos) > 1 else ''} nuevo{'s' if len(nuevos) > 1 else ''} en las últimas 24 horas: {nombres}.")
        except Exception:
            logger.exception("Error consultando leads nuevos")

        # 3) Facturas/presupuestos nuevos de TruKi en las últimas 24h
        truki_url = os.environ.get("TRUKI_SUPABASE_URL")
        truki_key = os.environ.get("TRUKI_SUPABASE_SERVICE_ROLE_KEY")
        if truki_url and truki_key:
            try:
                desde = (datetime.datetime.now(MADRID_TZ) - datetime.timedelta(hours=24)).isoformat()
                resp = requests.get(
                    f"{truki_url}/rest/v1/truki_invoices",
                    headers=_supabase_headers(truki_key),
                    params={"select": "cliente_nombre,total,tipo", "creado_en": f"gte.{desde}"},
                    timeout=8,
                )
                resp.raise_for_status()
                nuevas = resp.json()
                if nuevas:
                    total_nuevas = sum(float(r.get("total") or 0) for r in nuevas)
                    piezas.append(f"En TruKi ha entrado{'n' if len(nuevas) > 1 else ''} {len(nuevas)} documento{'s' if len(nuevas) > 1 else ''} nuevo{'s' if len(nuevas) > 1 else ''} en las últimas 24 horas, por {total_nuevas:.2f} euros en total.".replace(".", ",", 1))
            except Exception:
                logger.exception("Error consultando facturas nuevas de TruKi")

        # Marca como leídos los avisos de vigilancia ya contados, para no repetirlos mañana
        if avisos_ids:
            try:
                ids_filtro = ",".join(avisos_ids)
                requests.patch(
                    f"{supabase_url}/rest/v1/antonia_avisos",
                    headers={**headers, "Prefer": "return=minimal"},
                    params={"id": f"in.({ids_filtro})"},
                    json={"leido": True},
                    timeout=8,
                )
            except Exception:
                logger.exception("Error marcando avisos como leidos")

        if not piezas:
            return "El resto sigue todo igual, no hay novedades."
        return " ".join(piezas)

    @function_tool
    async def apuntar_nota(
        self,
        context: RunContext,
        texto: Annotated[str, Field(description="Lo que Jose quiere que recuerdes, tal cual lo diga — una preferencia de un cliente, un recordatorio suelto, cualquier cosa sin día ni hora concretos.")],
    ) -> str:
        """Guarda DE VERDAD una nota libre para recordar más adelante — úsala cuando Jose diga 'apúntate que...', 'recuerda que...' o 'no se te olvide que...' sobre algo que NO es una cita con día y hora (para eso está apuntar_en_agenda). Nunca le digas que lo has apuntado sin haber llamado a esta herramienta."""
        supabase_url = os.environ.get("SUPABASE_URL")
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not service_key:
            return "No he podido guardar la nota, no tengo acceso ahora mismo."
        try:
            resp = requests.post(
                f"{supabase_url}/rest/v1/antonia_notas",
                headers={**_supabase_headers(service_key), "Prefer": "return=minimal"},
                json={"texto": texto},
                timeout=8,
            )
            resp.raise_for_status()
        except Exception:
            logger.exception("Error guardando nota")
            return "No he podido guardar la nota ahora mismo, prueba en un momento."
        return f"Apuntado: {texto}. Confírmaselo a Jose repitiendo lo que has guardado."

    @function_tool
    async def consultar_notas(self, context: RunContext) -> str:
        """Consulta las notas libres guardadas anteriormente con apuntar_nota — úsala cuando Jose pregunte '¿qué tenía apuntado sobre...?', 'recuérdame qué anoté' o algo similar."""
        supabase_url = os.environ.get("SUPABASE_URL")
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not service_key:
            return "No tengo acceso a las notas ahora mismo."
        try:
            resp = requests.get(
                f"{supabase_url}/rest/v1/antonia_notas",
                headers=_supabase_headers(service_key),
                params={"select": "texto,creado_en", "archivada": "eq.false", "order": "creado_en.desc", "limit": "20"},
                timeout=8,
            )
            resp.raise_for_status()
            notas = resp.json()
        except Exception:
            logger.exception("Error consultando notas")
            return "No he podido consultar las notas ahora mismo, prueba en un momento."
        if not notas:
            return "No tienes ninguna nota guardada todavía."
        return "Tus notas guardadas: " + "; ".join(n["texto"] for n in notas) + "."

    @function_tool
    async def consultar_auditorias_seguridad(self, context: RunContext) -> str:
        """Consulta las últimas auditorías de seguridad periódicas de todo lo que rodea a TRUCO (web, TruKi, ANTONIA, Supabase, Netlify) — úsala cuando Jose pregunte '¿se ha hecho la auditoría?', '¿hay algo raro en la seguridad?' o similar."""
        supabase_url = os.environ.get("SUPABASE_URL")
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not service_key:
            return "No tengo acceso a las auditorías ahora mismo."
        try:
            resp = requests.get(
                f"{supabase_url}/rest/v1/security_audits",
                headers=_supabase_headers(service_key),
                params={"select": "ran_at,resumen,corregidos_automaticamente,pendientes_revision,alerta_intrusion", "order": "ran_at.desc", "limit": "3"},
                timeout=8,
            )
            resp.raise_for_status()
            auditorias = resp.json()
        except Exception:
            logger.exception("Error consultando auditorías de seguridad")
            return "No he podido consultar las auditorías ahora mismo, prueba en un momento."
        if not auditorias:
            return "Todavía no se ha ejecutado ninguna auditoría de seguridad."
        partes = []
        for a in auditorias:
            fecha = datetime.datetime.fromisoformat(a["ran_at"].replace("Z", "+00:00")).astimezone(MADRID_TZ).strftime("%-d de %B")
            alerta = " Alerta de posible intrusión, requiere tu atención inmediata." if a["alerta_intrusion"] else ""
            partes.append(f"{fecha}: {a['resumen']} ({a['corregidos_automaticamente']} corregidos solos, {a['pendientes_revision']} pendientes de tu revisión).{alerta}")
        return " ".join(partes)

    @function_tool
    async def enviar_correo(
        self,
        context: RunContext,
        destinatario: Annotated[str, Field(description="Dirección de correo del destinatario.")],
        asunto: Annotated[str, Field(description="Asunto del correo.")],
        cuerpo: Annotated[str, Field(description="Cuerpo del correo, tal como lo dicte Jose (o redáctalo tú de forma breve y profesional si solo te da la idea).")],
    ) -> str:
        """Envía DE VERDAD un correo electrónico — úsala en cuanto Jose diga 'manda un correo a...', 'escríbele a...' con una dirección de email. Si no tienes destinatario, asunto o qué decir, pregúntaselo antes — nunca inventes el contenido ni el destinatario. Después de enviarlo, confírmaselo a Jose diciendo a quién y sobre qué."""
        ok, error = _enviar_email_con_adjunto(destinatario, asunto, cuerpo)
        if not ok:
            return error
        return f"Correo enviado a {destinatario} con el asunto \"{asunto}\"."

    @function_tool
    async def listar_documentos_drive(self, context: RunContext) -> str:
        """Lista los documentos disponibles en la carpeta de Drive que Jose ha compartido contigo — úsala cuando pregunte "¿qué documentos tengo?" o antes de mandar uno si no está seguro del nombre exacto."""
        folder_id = os.environ.get("GOOGLE_DRIVE_FOLDER_ID")
        if not folder_id:
            return "No tengo ninguna carpeta de Drive configurada todavía — dile a Jose que falta compartirla."
        service = _get_drive_service()
        if service is None:
            return "No tengo acceso a Drive ahora mismo."
        try:
            resultado = service.files().list(
                q=f"'{folder_id}' in parents and trashed = false",
                fields="files(id, name)",
                pageSize=50,
            ).execute()
            archivos = resultado.get("files", [])
        except Exception:
            logger.exception("Error listando Drive")
            return "No he podido consultar la carpeta de Drive ahora mismo."
        if not archivos:
            return "No hay ningún documento en la carpeta todavía."
        return "Documentos disponibles: " + ", ".join(a["name"] for a in archivos) + "."

    @function_tool
    async def enviar_documento_por_correo(
        self,
        context: RunContext,
        nombre_documento: Annotated[str, Field(description="Nombre, o parte del nombre, del documento a buscar en la carpeta de Drive.")],
        destinatario: Annotated[str, Field(description="Dirección de correo a la que enviar el documento.")],
        mensaje: Annotated[str, Field(description="Mensaje breve para el cuerpo del correo.")] = "Te adjunto el documento solicitado.",
    ) -> str:
        """Busca un documento por nombre en la carpeta de Drive compartida y lo envía por correo DE VERDAD como adjunto. Úsala cuando Jose pida "mándale el/la [documento] a [email]" o "pásame por correo [documento]" (en ese caso el destinatario es él mismo, pregúntale a qué dirección si no la ha dicho)."""
        folder_id = os.environ.get("GOOGLE_DRIVE_FOLDER_ID")
        if not folder_id:
            return "No tengo ninguna carpeta de Drive configurada todavía — dile a Jose que falta compartirla."
        service = _get_drive_service()
        if service is None:
            return "No tengo acceso a Drive ahora mismo."
        try:
            # Escapar la barra invertida ANTES que la comilla — si no, un nombre
            # que ya trajera un \ dejaría una comilla sin escapar de verdad y
            # rompería (o manipularía) el filtro "q" de la API de Drive.
            nombre_escapado = nombre_documento.replace("\\", "\\\\").replace("'", "\\'")
            resultado = service.files().list(
                q=f"'{folder_id}' in parents and trashed = false and name contains '{nombre_escapado}'",
                fields="files(id, name, mimeType)",
                pageSize=5,
            ).execute()
            archivos = resultado.get("files", [])
        except Exception:
            logger.exception("Error buscando en Drive")
            return "No he podido buscar en la carpeta de Drive ahora mismo."
        if not archivos:
            return f"No he encontrado ningún documento que coincida con \"{nombre_documento}\" en la carpeta."
        archivo = archivos[0]
        try:
            if archivo["mimeType"].startswith("application/vnd.google-apps"):
                contenido = service.files().export(fileId=archivo["id"], mimeType="application/pdf").execute()
                nombre_final = archivo["name"] + ".pdf"
            else:
                contenido = service.files().get_media(fileId=archivo["id"]).execute()
                nombre_final = archivo["name"]
        except Exception:
            logger.exception("Error descargando de Drive")
            return "He encontrado el documento pero no he podido descargarlo ahora mismo."

        ok, error = _enviar_email_con_adjunto(destinatario, f"Documento: {archivo['name']}", mensaje, adjunto_bytes=contenido, adjunto_nombre=nombre_final)
        if not ok:
            return error
        return f"Enviado \"{archivo['name']}\" a {destinatario}."

    @function_tool
    async def activar_no_molestar(
        self,
        context: RunContext,
        dia: Annotated[
            Literal["hoy", "manana", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"],
            Field(description="Hasta qué día no molestar. Usa 'manana' si Jose dice simplemente 'hasta mañana'."),
        ] = "manana",
        hora: Annotated[str, Field(description="Hora en formato 24h HH:MM hasta la que dura el modo no molestar. '08:00' si Jose no da una hora concreta.")] = "08:00",
    ) -> str:
        """Activa el modo NO MOLESTAR: deja de avisar por Telegram hasta el día y hora indicados (todo lo que pase mientras tanto se guarda igualmente y se cuenta en el próximo saludo de buenos días). Actívalo en cuanto Jose te pida que no le molestes, sin dudar."""
        supabase_url = os.environ.get("SUPABASE_URL")
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not service_key:
            return "No he podido activar el modo no molestar, no tengo acceso a la configuración ahora mismo."
        now = datetime.datetime.now(MADRID_TZ)
        dias_semana = {"lunes": 0, "martes": 1, "miercoles": 2, "jueves": 3, "viernes": 4, "sabado": 5, "domingo": 6}
        if dia == "hoy":
            target_date = now.date()
        elif dia == "manana":
            target_date = now.date() + datetime.timedelta(days=1)
        else:
            dias_hasta = (dias_semana[dia] - now.weekday()) % 7 or 7
            target_date = now.date() + datetime.timedelta(days=dias_hasta)
        try:
            hh, mm = (int(p) for p in hora.split(":"))
        except Exception:
            hh, mm = 8, 0
        hasta = datetime.datetime.combine(target_date, datetime.time(hh, mm), tzinfo=MADRID_TZ)
        try:
            requests.patch(
                f"{supabase_url}/rest/v1/antonia_estado",
                headers={**_supabase_headers(service_key), "Prefer": "return=minimal"},
                params={"id": "eq.global"},
                json={"no_molestar_hasta": hasta.isoformat()},
                timeout=8,
            )
        except Exception:
            logger.exception("Error activando no molestar")
            return "No he podido activar el modo no molestar ahora mismo."
        return f"Perfecto, no te molesto hasta {_formatear_fecha_es(hasta)}. Si pasa algo antes, te lo cuento igual en cuanto quieras."

    @function_tool
    async def desactivar_no_molestar(self, context: RunContext) -> str:
        """Desactiva el modo no molestar de inmediato, si Jose pide volver a recibir avisos antes de lo previsto."""
        supabase_url = os.environ.get("SUPABASE_URL")
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not service_key:
            return "No he podido desactivarlo, no tengo acceso a la configuración ahora mismo."
        try:
            requests.patch(
                f"{supabase_url}/rest/v1/antonia_estado",
                headers={**_supabase_headers(service_key), "Prefer": "return=minimal"},
                params={"id": "eq.global"},
                json={"no_molestar_hasta": None},
                timeout=8,
            )
        except Exception:
            logger.exception("Error desactivando no molestar")
            return "No he podido desactivarlo ahora mismo."
        return "Hecho, vuelvo a avisarte de todo con normalidad."


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: agents.JobContext):
    session = AgentSession(
        llm=google.realtime.RealtimeModel(
            model="gemini-2.5-flash-native-audio-preview-12-2025",
            voice="Kore",  # distinta de la del asistente de ventas ("Achird"), para que se note que es otra persona
            enable_affective_dialog=True,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    silence_duration_ms=300,
                    prefix_padding_ms=20,
                    start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_HIGH,
                    end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_LOW,
                )
            ),
        ),
    )
    agent = AntoniaAgent()
    await session.start(room=ctx.room, agent=agent)
    await session.generate_reply(
        instructions="Saluda a Jose con cercanía y naturalidad, como una compañera que empieza a hablar con él — nada de guion leído, solo pregúntale en qué le puedes ayudar hoy."
    )


if __name__ == "__main__":
    agents.cli.run_app(server)

import base64
import datetime
import json
import logging
import os
import zoneinfo
from typing import Annotated

from dotenv import load_dotenv
from google.genai import types
from livekit import agents
from livekit.agents import AgentServer, AgentSession, Agent, RunContext, function_tool
from livekit.plugins import google
from pydantic import Field

load_dotenv(".env.local")

logger = logging.getLogger(__name__)

MADRID_TZ = zoneinfo.ZoneInfo("Europe/Madrid")
BUSINESS_HOURS = (9, 18)  # 9:00 a 18:00
SLOT_MINUTES = 30
CALENDAR_ID = os.environ.get("GOOGLE_CALENDAR_ID", "primary")


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


def _find_free_slots(service, max_slots=2, days_ahead=7, min_lead_minutes=60):
    now = datetime.datetime.now(MADRID_TZ)
    window_end = now + datetime.timedelta(days=days_ahead)
    busy = service.freebusy().query(
        body={
            "timeMin": now.isoformat(),
            "timeMax": window_end.isoformat(),
            "timeZone": "Europe/Madrid",
            "items": [{"id": CALENDAR_ID}],
        }
    ).execute()
    busy_ranges = busy["calendars"][CALENDAR_ID]["busy"]
    busy_ranges = [
        (
            datetime.datetime.fromisoformat(b["start"]).astimezone(MADRID_TZ),
            datetime.datetime.fromisoformat(b["end"]).astimezone(MADRID_TZ),
        )
        for b in busy_ranges
    ]

    earliest_bookable = now + datetime.timedelta(minutes=min_lead_minutes)
    slots = []
    day_date = now.date()
    days_checked = 0

    while len(slots) < max_slots and days_checked <= days_ahead:
        day_start = datetime.datetime.combine(
            day_date, datetime.time(BUSINESS_HOURS[0], 0), tzinfo=MADRID_TZ
        )
        day_end = datetime.datetime.combine(
            day_date, datetime.time(BUSINESS_HOURS[1], 0), tzinfo=MADRID_TZ
        )
        if day_date.weekday() < 5:  # lunes a viernes
            slot_start = max(day_start, earliest_bookable)
            # redondear al siguiente múltiplo de SLOT_MINUTES
            minutes_over = slot_start.minute % SLOT_MINUTES
            if minutes_over or slot_start.second or slot_start.microsecond:
                slot_start += datetime.timedelta(minutes=SLOT_MINUTES - minutes_over)
                slot_start = slot_start.replace(second=0, microsecond=0)

            while slot_start + datetime.timedelta(minutes=SLOT_MINUTES) <= day_end and len(slots) < max_slots:
                slot_end = slot_start + datetime.timedelta(minutes=SLOT_MINUTES)
                overlaps = any(
                    slot_start < b_end and slot_end > b_start
                    for b_start, b_end in busy_ranges
                )
                if not overlaps:
                    slots.append(slot_start)
                slot_start += datetime.timedelta(minutes=SLOT_MINUTES)
        day_date += datetime.timedelta(days=1)
        days_checked += 1
    return slots

SYSTEM_INSTRUCTIONS = """Eres el "Asistente TRUCO PRO", el operador telefónico de TRUCO technology. Hablas en español de España, con voz cercana y natural, como una persona real del departamento tecnológico — nunca suenas como un robot ni con frases genéricas. Como es una llamada de voz, responde en frases cortas y naturales, sin listas, sin markdown, sin leer símbolos en voz alta.

DATOS REALES DE TRUCO technology (no inventes nada fuera de esto; si no lo sabes, dilo):

QUÉ ES: Departamento Tecnológico externalizado para pymes y autónomos en España. Implantan tecnología (proyectos) y luego la mantienen cada mes (Departamento Tecnológico).

PROYECTOS (pago único, + IVA 21%):
- Web Esencial: 499 euros. Cinco páginas, responsive, SEO básico, lista en siete a diez días. Incluye un mes de Departamento Lite gratis.
- Web Profesional: desde 790 euros. Diseño a medida, páginas ilimitadas, integraciones, IA si se necesita. Entrega en dos a cuatro semanas. Incluye un mes de Departamento Lite gratis.
- Digitaliza tu Empresa: desde 590 euros, precio según soluciones elegidas. Implantación de noventa días. Un mes de Departamento gratis (Lite si son una o dos soluciones, Pro si son tres o más), desde el mes dos precio estándar. Más de tres soluciones necesita presupuesto personalizado.
- Se puede combinar un proyecto web con Digitaliza en la misma compra.

SOLUCIONES INDIVIDUALES DE DIGITALIZA (+ IVA):
IA para WhatsApp quinientos noventa euros. IA para Web trescientos cincuenta euros. IA para Correo trescientos cincuenta euros. CRM cuatrocientos euros. Reservas online trescientos cincuenta euros. Automatizaciones cuatrocientos euros. Integraciones trescientos cincuenta euros. Gestión documental cuatrocientos euros. Firma digital trescientos euros.

DEPARTAMENTO TECNOLÓGICO (cuota mensual, + IVA):
- Lite: ciento noventa y nueve euros al mes. Hasta dos soluciones tecnológicas.
- Pro: trescientos noventa y nueve euros al mes. Hasta seis soluciones.
- Pago anual: diez por ciento de descuento.
- Se puede acceder directo al Departamento sin proyecto previo, mismo precio, sin mes gratis.

CONDICIONES:
- Períodos de implantación: proyectos web, sesenta días en total (treinta días mes uno gratis, treinta días mes dos a precio estándar). Digitaliza, noventa días en total (treinta días mes uno gratis, sesenta días meses dos y tres a precio estándar). Después de ese período, sin permanencia.
- Garantía: si en los primeros treinta días no está satisfecho, se devuelve el primer mes íntegro. Incidencias técnicas siempre sin coste.
- Dominio y hosting: siempre a nombre y coste del cliente.
- Pago con Stripe. Factura automática.
- La consultoría gratuita de veinte a treinta minutos se reserva por Google Calendar.

REGLAS:
1. Responde solo con estos datos. Nunca inventes precios ni condiciones.
2. Sé breve, dos o tres frases por turno como mucho, como una conversación real por teléfono.
3. Si la pregunta es algo que no puedes resolver (asesoría legal o fiscal personalizada, o algo totalmente fuera de TRUCO), dilo con naturalidad y ofrece que alguien del equipo le llame, sin usar ningún marcador especial en la voz.
4. Cuando necesites un instante antes de responder (una pregunta más larga o que requiera pensar), empieza la frase con una muletilla natural como "mmm", "a ver", "pues", o "vale, déjame pensar" — así suena a una persona real pensando, no a un silencio robótico. No lo hagas en cada turno, solo cuando de verdad haga falta un momento.

RESERVAR CITAS POR VOZ:
Tienes dos herramientas para gestionar la consultoría gratuita de 20-30 minutos directamente en la llamada: `consultar_disponibilidad` y `reservar_cita`. Cuando el cliente quiera reservar o tú se lo propongas y acepte:
1. Llama a `consultar_disponibilidad` y ofrécele uno o dos huecos en voz alta (por ejemplo "tengo el jueves a las 11 o el viernes a las 17, ¿cuál te viene mejor?").
2. Si le interesa un hueco, pídele en la conversación los datos que falten: nombre completo, email y teléfono.
3. Cuando tengas el hueco elegido y los datos, llama a `reservar_cita` con esa información, y confírmaselo en voz alta.
4. Si alguna herramienta indica que no hay huecos o falla, dile que no ha podido completarse y ofrece que alguien del equipo le llame."""


class TrucoAgent(Agent):
    def __init__(self):
        super().__init__(instructions=SYSTEM_INSTRUCTIONS)

    @function_tool
    async def consultar_disponibilidad(self, context: RunContext) -> str:
        """Consulta los próximos huecos libres de 20-30 minutos en el calendario de
        consultorías gratuitas. Úsala cuando el cliente quiera reservar una cita, antes
        de pedirle ningún dato. Devuelve como máximo 2 huecos disponibles."""
        service = _get_calendar_service()
        if service is None:
            return "La agenda no está disponible ahora mismo. Ofrece que alguien del equipo le llame."
        try:
            slots = _find_free_slots(service)
        except Exception:
            logger.exception("Error consultando disponibilidad")
            return "No se pudo consultar la agenda ahora mismo. Ofrece que alguien del equipo le llame."
        if not slots:
            return "No hay huecos libres en los próximos días. Ofrece que alguien del equipo le llame."
        opciones = "; ".join(
            s.strftime("%A %d de %B a las %H:%M") for s in slots
        )
        return f"Huecos disponibles: {opciones}. Pídele al cliente que elija uno."

    @function_tool
    async def reservar_cita(
        self,
        context: RunContext,
        fecha_hora_iso: Annotated[
            str,
            Field(description="Fecha y hora exactas del hueco elegido, en formato ISO 8601 con zona horaria, ej. 2026-07-10T11:00:00+02:00"),
        ],
        nombre: Annotated[str, Field(description="Nombre completo del cliente")],
        email: Annotated[str, Field(description="Email del cliente")],
        telefono: Annotated[str, Field(description="Teléfono del cliente")],
    ) -> str:
        """Confirma y crea la reserva de la consultoría gratuita en el hueco elegido,
        una vez tengas la fecha/hora exacta y los datos de contacto del cliente."""
        service = _get_calendar_service()
        if service is None:
            return "No se pudo confirmar la reserva. Ofrece que alguien del equipo le llame."
        try:
            start = datetime.datetime.fromisoformat(fecha_hora_iso)
            end = start + datetime.timedelta(minutes=SLOT_MINUTES)
            service.events().insert(
                calendarId=CALENDAR_ID,
                body={
                    "summary": f"Consultoría gratuita TRUCO — {nombre}",
                    "description": f"Reservada por voz.\nTeléfono: {telefono}\nEmail: {email}",
                    "start": {"dateTime": start.isoformat(), "timeZone": "Europe/Madrid"},
                    "end": {"dateTime": end.isoformat(), "timeZone": "Europe/Madrid"},
                    "attendees": [{"email": email}] if email else [],
                },
            ).execute()
        except Exception:
            logger.exception("Error creando la reserva")
            return "No se pudo confirmar la reserva. Ofrece que alguien del equipo le llame."
        return f"Reserva confirmada para {nombre} el {start.strftime('%A %d de %B a las %H:%M')}. Confírmaselo al cliente."


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: agents.JobContext):
    session = AgentSession(
        llm=google.realtime.RealtimeModel(
            model="gemini-2.5-flash-native-audio-preview-12-2025",
            voice="Kore",
            thinking_config=types.ThinkingConfig(thinking_budget=0),
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    silence_duration_ms=500,
                    prefix_padding_ms=20,
                )
            ),
        ),
    )

    agent = TrucoAgent()

    await session.start(room=ctx.room, agent=agent)

    await session.generate_reply(
        instructions="Saluda brevemente en español como el Asistente TRUCO PRO y pregunta en qué puedes ayudar."
    )


if __name__ == "__main__":
    agents.cli.run_app(server)

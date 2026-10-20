# Conocimiento del proceso: órdenes de compra en Periferia

## El proceso de compra

Toda compra entra a administración por correo con tres piezas: la **solicitud** (un Excel con proveedor, descripción, centro de costo, subárea, cantidad, valor y moneda), la **cotización** del proveedor y el **correo de aprobación** del líder del área. La analista administrativa crea la orden de compra (OC) en SAP digitando esos datos, elige las condiciones de pago y el indicador de IVA, y adjunta el correo de aprobación convertido a PDF como evidencia. Después vienen la recepción, la factura y el pago, que no hacen parte de este agente.

La OC es el **control previo del gasto**: antes de comprometer dinero con un proveedor, alguien con autoridad lo aprobó, el proveedor está registrado y el valor está dentro del tope de quien aprobó.

| Actor | Papel |
|---|---|
| Solicitante | Arma el paquete y lo envía a compras. |
| Líder aprobador | Responde el correo con "Aprobado". Cada centro de costo tiene aprobadores con un tope en pesos. |
| Analista administrativa | Verifica el paquete y crea la OC. Es quien conversa con el agente y confirma excepciones. |
| Contabilidad / auditoría | Revisa `out/control.csv`: un registro por intento, con bloqueos, confirmaciones y si fue retroactiva. |

## Reglas de control (RC1–RC10)

Tres tipos de resultado: **bloqueo** (la OC no se crea; se devuelve al solicitante), **confirmación** (la OC puede crearse solo si la analista lo confirma; queda registrado como excepción) y **derivado** (el agente completó un dato desde los maestros y lo informa).

| Regla | Tipo | Qué verifica | Qué significa para el negocio |
|---|---|---|---|
| RC1 | Bloqueo | El proveedor existe en el maestro (por NIT; si no hay NIT, por nombre normalizado) y está activo. | No se compra a quien no está creado en SAP. Un proveedor inactivo fue bloqueado a propósito (riesgo, incumplimiento, cierre). |
| RC2 | Bloqueo | Hay correo de aprobación, dice "Aprobado" y viene de un aprobador autorizado para ese centro de costo. | Un líder solo aprueba el gasto de su propia área. Una aprobación de otra área no vale. |
| RC3 | Bloqueo | El valor total no supera el tope del aprobador en ese centro. | Las autoridades de gasto son escalonadas; por encima del tope aprueba alguien más. |
| RC4 | Bloqueo | La subárea pertenece al centro de costo. | Evita imputar el gasto a una combinación que no existe; corregirlo después cuesta un ajuste contable. |
| RC5 | Confirmación | El total de la cotización está dentro del 2 % del total de la solicitud. Sin cotización, también pide confirmación. | Si la cotización dice otra cosa, alguien se equivocó o la oferta cambió. Lo aprobado fue la solicitud; la analista decide si procede y la diferencia queda registrada. |
| RC6 | Confirmación + derivado | Si la solicitud no trae indicador de IVA, se toma el del proveedor y se pide confirmar. Un indicador que no existe en el maestro también pide confirmación. | El IVA afecta el valor contabilizado; se puede inferir, pero no asumir en silencio. |
| RC7 | Derivado | Si la solicitud no trae condiciones de pago, se toman las del proveedor. Solo se informa. | Las condiciones las fija el acuerdo comercial con el proveedor, no cada solicitud. |
| RC8 | Confirmación | Existe una factura con fecha anterior a la solicitud: la OC es **retroactiva**. Queda marcada en el log de control. | Ver abajo. La dirección quiere medirlo. |
| RC9 | Confirmación | La aprobación es de la misma fecha o posterior a la solicitud. | Una aprobación anterior a la solicitud puede ser de otra versión del pedido. |
| RC10 | Bloqueo | cantidad × valor unitario = valor total (± 1 peso). | Un total que no cuadra es un error de digitación en el Excel; se devuelve. |

## OC retroactiva: qué es y por qué se mide

Una OC es retroactiva cuando se crea **después** de que el proveedor ya facturó: la compra ya ocurrió y la OC se hace solo para poder radicar la factura. En ese momento la OC deja de ser un control previo y se vuelve un trámite posterior: no hubo negociación con cotización, no se verificó el tope del aprobador antes de comprometer el gasto y el centro de costo se entera cuando ya debe pagar. El agente no la rechaza (la política la decide la dirección), pero la marca con `retroactiva = true`, exige confirmación de la analista y la deja en `out/control.csv` para que se pueda medir el porcentaje por centro de costo y por período.

## Maestros

| Maestro | Campos | Para qué sirve |
|---|---|---|
| `proveedores.json` | `codigo_sap`, `nit`, `nombre`, `condiciones_pago_default`, `indicador_iva_default`, `activo` | RC1; fuente de los derivados RC6 y RC7; el `codigo_sap` es el número de acreedor que SAP usa en la OC. |
| `centros-costo.json` | `centro_costo`, `nombre`, `subareas[]`, `aprobadores[{ email, nombre, tope }]` | RC2, RC3, RC4. |
| `indicadores-iva.json` | `codigo`, `descripcion`, `tasa` | Valida el indicador de IVA (C0 excluido 0 %, C1 19 %, C2 5 %). |
| `condiciones-pago.json` | `codigo`, `descripcion`, `dias` | Valida las condiciones de pago (Z000 inmediato, Z015, Z030, Z060 días fecha factura). |

Los NIT se comparan sin puntos y sin dígito de verificación (`900.555.111-2` = `900555111`). Los nombres se comparan sin mayúsculas, tildes ni puntuación (`TecnoSuministros S.A.S.` = `tecnosuministros sas`).

## Campos del payload de la OC (lo que ve SAP)

| Campo | Significado |
|---|---|
| `referencia` | `solicitud_id`, id del correo y número de la cotización. El `solicitud_id` es la clave de idempotencia: la misma solicitud nunca genera dos OC. |
| `sociedad` = `1000` | Sociedad (company code): la entidad legal que contabiliza y paga. Periferia opera con una sola. |
| `organizacion_compras` = `1000` | Organización de compras: la unidad que negocia con proveedores. Una sola. |
| `proveedor` | `codigo_sap` (número de acreedor), NIT y nombre, tomados del maestro, no de la solicitud. |
| `moneda` | `COP` o `USD`. |
| `condiciones_pago` | Código `Zxxx`: días de plazo para pagar la factura. `Z000` pago inmediato, `Z015`/`Z030`/`Z060` días fecha factura. |
| `aprobador` | Email, fecha de aprobación y `sha256` de la evidencia (el correo de aprobación guardado en `out/<caso>/aprobacion.txt`). El hash permite demostrar que el adjunto no cambió. |
| `posiciones[].numero` | Número de posición SAP: 10, 20, 30… En este proceso cada solicitud tiene una posición (10). |
| `posiciones[].descripcion` | Texto breve de la posición. SAP admite **máximo 40 caracteres**; descripciones más largas se recortan y el texto completo queda en la solicitud. |
| `posiciones[].cantidad` y `unidad` | `UN` unidades (bienes, licencias), `H` horas (servicios por hora), `MES` meses (servicios recurrentes). |
| `posiciones[].precio_unitario` | Valor unitario tal como viene en la solicitud. En este proceso los precios se manejan **con IVA incluido**. |
| `posiciones[].centro_costo` y `subarea` | A quién se le imputa el gasto. El centro de costo es la imputación contable (categoría K en SAP); la subárea es una apertura interna de Periferia. |
| `posiciones[].indicador_iva` | Código de impuesto `Cx`: le dice a SAP qué tasa de IVA aplicar y cómo contabilizarla. |
| `excepciones[]` | Confirmaciones aceptadas por la analista: código de la regla, detalle y quién confirmó. Es la trazabilidad de por qué se creó una OC con una alerta abierta. |

## Archivos que produce el proceso

| Archivo | Contenido |
|---|---|
| `out/<caso>/aprobacion.txt` (y `.pdf` si está disponible) | Evidencia de aprobación: encabezados, cuerpo y `SHA-256`. |
| `out/<caso>/trazabilidad.json` | Para cada campo del payload, de dónde salió: `solicitud`, `cotizacion`, `maestro.<nombre>`, `derivado`, `constante`. |
| `out/sap/ordenes.jsonl` | OC creadas en el SAP simulado, numeradas desde `4500000001`. |
| `out/control.csv` | Una fila por intento: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts`. |
| `out/log.jsonl` | Cada llamada a herramienta: sesión, herramienta, ok y resumen. |

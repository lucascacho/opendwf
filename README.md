# opendwf — Visor DWF

Visor de planos **.dwf** (Autodesk Design Web Format, 2D) para Mac, sin instalar nada:
es un único archivo HTML que se abre en Safari, Chrome o Firefox.
El archivo DWF se lee localmente en el navegador; no se sube a ningún servidor.

## Cómo usarlo

1. Descargá [`dist/VisorDWF.html`](dist/VisorDWF.html) (botón *Download raw file* en GitHub).
2. Abrilo con doble clic.
3. Arrastrá un `.dwf` a la ventana, o usá **Abrir…** (⌘O).

| Acción | Cómo |
| --- | --- |
| Zoom | Rueda del mouse, pellizco en el trackpad, `+` / `−`, doble clic |
| Mover el plano | Arrastrar, flechas, o Mayús + rueda |
| Ajustar a la ventana | Botón **Ajustar** o tecla `0` |
| Cambiar de hoja | Barra lateral, `[` / `]` o Re Pág / Av Pág |
| Capas | Botón **Capas** (mostrar u ocultar cada capa) |
| Fondo oscuro / grosores de línea | Botones **Fondo oscuro** y **Grosores** |
| Guardar como imagen | **Exportar PNG** (hoja actual, 200 ppp) |

## Qué soporta

- Paquetes DWF 6 (varias hojas, tamaño y color de papel, miniaturas, marcas de revisión).
- DWF antiguos de un solo flujo (versiones 0.x) y archivos `.w2d` sueltos.
- Líneas, polígonos, rellenos, círculos, arcos y elipses, texto, capas, grosores y patrones de línea.
- Imágenes incrustadas (JPEG, PNG, RGB, RGBA, indexadas), macros y sombreado Gouraud (aproximado).

## Limitaciones conocidas

- No abre modelos **3D**, archivos **.dwfx** (formato XPS) ni DWF protegidos con contraseña.
- No usa las tipografías incrustadas en el DWF: toma la fuente del sistema con el mismo nombre
  (o una parecida), así que algún texto puede verse levemente distinto al original.
- No aplica el recorte por ventanas gráficas (viewports) ni muestra imágenes bitonales tipo fax (grupo 3/4).
- Las curvas Bézier y las imágenes en formato de texto no se dibujan.

## Desarrollo

Requiere Node.js. No hay dependencias para compilar.

```bash
node build.js
```

Regenera `dist/VisorDWF.html` a partir de `src/`.

```bash
node test/probe.js plano.dwf
```

Muestra un resumen de lo que se decodifica (hojas, cantidad de elementos, avisos).

```bash
node test/shot.js plano.dwf captura.png
```

Abre el visor en un navegador sin interfaz y guarda una captura (requiere Playwright).

### Estructura

| Archivo | Contenido |
| --- | --- |
| `src/dwf-core.js` | Decodificador: inflate, ZIP, flujo W2D y paquete DWF. Sin dependencias; también corre en Node. |
| `src/viewer.js` | Interfaz y dibujo en canvas. |
| `src/index.html`, `src/style.css` | Plantilla y estilos. |
| `src/tables.json` | Paleta por defecto y diccionario de compresión del formato. |
| `build.js` | Une todo en un único HTML. |

## Sobre el formato

El decodificador está escrito desde cero, tomando como referencia del formato el código fuente del
DWF Toolkit publicado por Autodesk. Las tablas de `src/tables.json` (paleta de colores por defecto y
diccionario de precarga de la compresión) son datos definidos por el formato y provienen de ese toolkit.

DWF y AutoCAD son marcas de Autodesk, Inc. Este proyecto no está afiliado a Autodesk.

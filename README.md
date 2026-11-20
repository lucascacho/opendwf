# Visor DWF

Visor de planos **.dwf** (Autodesk Design Web Format, 2D) que funciona en cualquier Mac sin instalar nada:
es un único archivo HTML que se abre en Safari, Chrome o Firefox. El archivo DWF se lee localmente; no se sube a ningún servidor.

## Uso

1. Abrí `dist/VisorDWF.html` con doble clic (se abre en el navegador).
2. Arrastrá un `.dwf` a la ventana, o usá **Abrir…** (⌘O).

| Acción | Cómo |
| --- | --- |
| Zoom | Rueda del mouse, pellizco en el trackpad, `+` / `−`, doble clic |
| Mover el plano | Arrastrar, flechas, o Mayús + rueda |
| Ajustar a la ventana | Botón **Ajustar** o tecla `0` |
| Cambiar de hoja | Barra lateral, `[` / `]` o Re Pág / Av Pág |
| Capas | Botón **Capas** (mostrar/ocultar cada capa) |
| Fondo oscuro / grosores de línea | Botones **Fondo oscuro** y **Grosores** |
| Guardar como imagen | **Exportar PNG** (hoja actual, 200 ppp) |

## Qué soporta

- Paquetes DWF 6 (varias hojas, tamaño y color de papel, miniaturas, marcas de revisión).
- DWF antiguos de un solo flujo (versiones 0.x) y archivos `.w2d` sueltos.
- Líneas, polígonos, rellenos, círculos, arcos y elipses, texto, capas, grosores, patrones de línea,
  imágenes incrustadas (JPEG, PNG, RGB, RGBA, indexadas), macros y sombreado Gouraud (aproximado).

No soporta (todavía): modelos **3D**, archivos **.dwfx** (formato XPS), DWF con contraseña,
imágenes bitonales fax (grupo 3/4) y las tipografías incrustadas (se usa la fuente del sistema con el mismo nombre).

## Desarrollo

```bash
node build.js          # regenera dist/VisorDWF.html a partir de src/
node test/probe.js archivo.dwf            # resumen de lo que se decodifica
node test/shot.js archivo.dwf salida.png  # captura con Playwright
```

- `src/dwf-core.js`: decodificador (inflate, ZIP, flujo W2D, paquete DWF). Sin dependencias; también corre en Node.
- `src/viewer.js`, `src/index.html`, `src/style.css`: interfaz y dibujo en canvas.
- `src/tables.json`: paleta por defecto y diccionario de compresión del formato.

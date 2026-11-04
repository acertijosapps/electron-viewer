# Changelog

Todas las notas relevantes de este proyecto se documentan aquí.
Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/); versionado [SemVer](https://semver.org/lang/es/).

## [Sin liberar]

### Añadido
- Tooltips propios en los controles del visor (lanzar, ventana, recargar, DevTools, tamaño y captura), porque el panel de navegador de Claude no muestra los de `title`. Salen al pasar el puntero o al enfocar con el teclado, también en botones deshabilitados.

### Cambiado

### Corregido

### Eliminado
- Modo marco del visor y `frame` de `screenshot` (MCP y `GET /api/screenshot`). Recortaba la pantalla en el área de la ventana, así que también capturaba cualquier otra ventana que la tapara y la mandaba al visor o al agente; los menús contextuales nativos, además, no salían. Capturar solo la ventana con su marco no es posible desde Electron en macOS (`desktopCapturer` no lista las ventanas de la propia app), así que se quita.

## [1.0.0] - 2026-11-02

### Añadido
- Visor web de apps Electron: `Page.startScreencast` (JPEG) por WebSocket a un canvas, con el último frame guardado para quien se conecta después. Con el foco y el ciclo de vida emulados, la ventana sigue pintando aunque esté tapada o minimizada.
- Input en vivo desde el visor: movimiento y hover, clic, doble y triple clic, botón derecho, arrastre real, rueda y teclado completo (un textarea invisible recibe las teclas y también el texto de IME o dictado). En macOS, ⌘A/⌘C/⌘V/⌘X/⌘Z van como comandos de edición.
- Combo con las apps (puertos CDP 9222–9231, lanzadas o adjuntadas) y sus ventanas; botón para lanzar `electron .` del proyecto en puertos libres (CDP desde 9222, inspector del main desde 9229) y formulario para adjuntarse a un puerto.
- Controles: recargar, DevTools (del proceso main o, sin él, el frontend que sirve el puerto CDP), tamaño de la ventana (real con el main, emulado sin él), captura PNG y modo marco.
- Modo marco y `screenshot` con `frame`: captura del área de la ventana en pantalla desde el proceso main (`desktopCapturer`), con barra de título, menús contextuales y diálogos nativos. En macOS necesita el permiso de Grabación de pantalla para la app; si falta, el error dice a qué app darlo.
- API HTTP del visor (`/api/windows`, `/project`, `/launch`, `/attach`, `/screenshot`, `/click`, `/drag`, `/hover`, `/scroll`, `/text`, `/key`, `/resize`, `/reload`, `/evaluate`, `/evaluate-main`, `/devtools`, `/ax-tree`, `/logs`): solo en 127.0.0.1, con `Host` y origen locales y `POST` con `application/json`.
- MCP por stdio (`list_windows`, `launch_app`, `attach`, `screenshot`, `click`, `drag`, `hover`, `scroll`, `type_text`, `press_key`, `resize_window`, `reload`, `evaluate`, `evaluate_main`, `get_accessibility_tree`, `get_console_logs`): habla con el visor para que todo se vea en vivo, o con CDP directo si el visor está apagado. Coordenadas normalizadas 0–1.
- Árbol de accesibilidad en texto, con el centro normalizado de cada elemento interactivo listo para `click`.
- Logs de consola y excepciones del renderer y del proceso main (los últimos 1000 por app) y la salida estándar de las apps lanzadas.
- Registro de apps en `~/.cache/electron-viewer`: el visor ve las apps que lanzó el MCP sin visor, y al revés.
- Comando `electron-viewer` para `npx @acertijosapps/electron-viewer`: sin argumentos arranca el visor (`--port`, `--host`, `--project`, `--attach`, `--inspect`) y `mcp` arranca el MCP (`--viewer-url`, `--project`); `--help` y `--version`.
- App de ejemplo en `example/` (fuera del paquete de npm) para probar clics, texto, arrastre, scroll, menú contextual, diálogos y varias ventanas.
- Registro oficial de MCP como `io.github.acertijosapps/electron-viewer`: `mcpName` en `package.json`, `server.json` y workflow que valida `server.json` en cada PR y lo publica por OIDC al crear un Release de GitHub.
- Git flow del proyecto: CHANGELOG, guía de contribución, hooks de git (Conventional Commits y ramas protegidas) y CI en GitHub Actions. `npm install` en el repo activa los hooks con un script `prepare`, que no corre al instalar el paquete desde npm.

<!--
 Al promover beta → main: renombra [Sin liberar] a [X.Y.Z] - AAAA-MM-DD y vuelve a crear una
 sección [Sin liberar] vacía encima de ella. Las versiones liberadas quedan debajo, de la más
 nueva a la más vieja.
-->

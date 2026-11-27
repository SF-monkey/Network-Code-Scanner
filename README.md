# QR Bridge

Use a phone camera as a live scanner: the phone streams video to a local server page, and the page decodes
QR codes and barcodes (ZXing) and can copy every scan to the clipboard.

## One-click start / stop

Requires [Node.js](https://nodejs.org/) 18 or newer. Dependencies install automatically on the first run.

| | Windows | macOS | Linux |
|---|---|---|---|
| Start | double-click `start.bat` | double-click `start.command` | `./start.sh` |
| Stop | double-click `stop.bat` | double-click `stop.command` | `./stop.sh` |

Also available everywhere: `npm run up`, `npm run down`, `npm run restart`, `npm run status`
(or `node control.js start|stop|restart|status`).

`start` installs what is missing, launches the server in the background, waits until it answers, prints the
addresses and opens the viewer in your browser. Add `--no-open` to skip the browser.
Logs go to `logs/server.log`; the process id is kept in `.qr-bridge.pid`.

To use another port: `PORT=9443 ./start.sh` (macOS/Linux) or `set PORT=9443 && start.bat` (Windows).

## Using it

1. Open `https://localhost:8443/` on this computer (the viewer).
2. Open `https://<this-computer's-LAN-IP>:8443/phone.html` on the phone (same Wi-Fi) and tap **Start sending**.
3. Accept the certificate warning once on each device (the certificate is self-signed).

Run in the foreground instead (Ctrl+C to quit): `npm start`.

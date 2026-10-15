

import os
import socket
import subprocess
import sys
from pathlib import Path

import uvicorn

PORT = int(os.environ.get("PORT", "8443"))
ROOT = Path(__file__).resolve().parent
CERT_DIR = Path(os.environ.get("CERT_DIR", ROOT))
CERT = CERT_DIR / "cert.pem"
KEY = CERT_DIR / "key.pem"
# IP-адреса через запятую, которые надо добавить в сертификат и показать при старте
# (нужно в Docker: изнутри контейнера не видно LAN-адрес хоста).
EXTRA_IPS = [ip.strip() for ip in os.environ.get("EXTRA_IPS", "").split(",") if ip.strip()]


def lan_ips() -> list[str]:
    ips = set()
    for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
        ips.add(info[4][0])
    try:  # адрес, через который идёт трафик наружу
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith(("127.", "169.254.")))


def make_cert(ips: list[str]) -> None:
    san = ",".join(["DNS:localhost", "IP:127.0.0.1", *(f"IP:{ip}" for ip in ips)])
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
         "-keyout", str(KEY), "-out", str(CERT), "-subj", "/CN=QR Scanner", "-addext", f"subjectAltName={san}"],
        check=True, capture_output=True,
    )


def main() -> None:
    ips = EXTRA_IPS or lan_ips()
    if not (CERT.exists() and KEY.exists()):
        try:
            CERT_DIR.mkdir(parents=True, exist_ok=True)
            make_cert(ips)
        except (OSError, subprocess.CalledProcessError) as e:
            sys.exit(f"Не удалось создать сертификат через openssl: {e}")

    print("ФК — QR запущен. Откройте в браузере:")
    print(f"  на этом компьютере:  https://localhost:{PORT}")
    for ip in ips:
        print(f"  с телефона:          https://{ip}:{PORT}")
    print("Браузер предупредит о сертификате — это нормально: «Дополнительно» → «Перейти на сайт».")
    print("Остановка: Ctrl+C")
    uvicorn.run("app.main:app", host="0.0.0.0", port=PORT, ssl_certfile=str(CERT), ssl_keyfile=str(KEY),
                app_dir=str(ROOT), proxy_headers=True)


if __name__ == "__main__":
    main()

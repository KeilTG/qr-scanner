FROM python:3.12-slim

# openssl нужен serve.py для генерации самоподписанного сертификата
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY index.html jsQR.js serve.py ./

# Сертификат храним вне раздаваемой папки, чтобы key.pem нельзя было скачать
ENV PORT=8443 \
    CERT_DIR=/certs \
    PYTHONUNBUFFERED=1
VOLUME ["/certs"]
EXPOSE 8443

CMD ["python", "serve.py"]

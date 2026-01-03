FROM ghcr.io/puppeteer/puppeteer:24.2.0

WORKDIR /app

COPY --chown=pptruser:pptruser package.json package-lock.json* ./
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm install --omit=dev --no-audit --no-fund

COPY --chown=pptruser:pptruser . .

CMD ["node","cli/stream.js"]

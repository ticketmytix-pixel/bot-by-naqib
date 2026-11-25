FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python3-pil ca-certificates libgomp1 fonts-liberation fonts-dejavu-core \
  && pip3 install --break-system-packages --no-cache-dir yt-dlp "rembg[cpu]" \
  && python3 -c "from rembg import new_session; new_session('u2netp')" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]

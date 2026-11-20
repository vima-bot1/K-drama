FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm --prefix server install --omit=dev && npm --prefix client install && npm run build && npm --prefix server run fonts
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]

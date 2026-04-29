FROM node:20-alpine

WORKDIR /app

COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev

COPY public ./public
COPY server ./server

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/server.js"]

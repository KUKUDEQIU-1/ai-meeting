FROM node:20-bookworm-slim

WORKDIR /app/server

COPY server/package*.json ./
RUN npm install --omit=dev

COPY server/ ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]

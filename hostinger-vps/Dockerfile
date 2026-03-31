FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
EXPOSE 3001
CMD ["node", "server.mjs"]

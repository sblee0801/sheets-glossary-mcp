FROM node:18-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY index.js .

CMD ["node", "index.js"]

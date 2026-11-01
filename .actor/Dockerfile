FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --ignore-scripts --no-audit --no-fund && npm run build && npm prune --omit=dev --ignore-scripts
CMD ["npm", "run", "start:apify"]

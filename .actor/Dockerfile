FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
# apify is a devDependency so npm and npx installs of mcp-server-ftp do not
# download it. This image needs it to compile src/apify.ts and to run
# build/apify.js, so move it to dependencies and install production deps only.
RUN npm install --ignore-scripts --no-audit --no-fund \
 && npm run build \
 && npm pkg delete devDependencies.apify \
 && npm pkg set dependencies.apify="^3.7.2" \
 && rm -rf node_modules package-lock.json \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund
CMD ["npm", "run", "start:apify"]

# Generated by https://smithery.ai. See: https://smithery.ai/docs/config#dockerfile
FROM node:lts-alpine

WORKDIR /app

# Copy necessary files
COPY package.json package-lock.json* ./
COPY tsconfig.json ./
COPY src ./src

# Install dependencies (ignoring scripts if necessary)
RUN npm install --ignore-scripts

# Build the project
RUN npm run build

# Expose any port if needed (not needed since it's a stdio server)

# Start the MCP server
CMD ["npm", "start"]

FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build TypeScript to dist/
RUN npm run build

# Expose Dashboard Port
EXPOSE 4405

# Start the application
CMD ["node", "--max-old-space-size=4096", "dist/index.js"]

FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG BACKEND_URL=http://backend:8000
ENV BACKEND_URL=$BACKEND_URL NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_API_MODE=remote
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]

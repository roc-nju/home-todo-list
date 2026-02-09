FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=5173
EXPOSE 5173
CMD ["npm", "start"]

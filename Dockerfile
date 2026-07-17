FROM node:20-slim AS frontend-build

WORKDIR /frontend
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tailwind.config.ts postcss.config.cjs ./
COPY src ./src
RUN npm run build

FROM python:3.12.7-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir -r requirements.txt

COPY . ./
COPY --from=frontend-build /frontend/dist ./dist

EXPOSE 8000

CMD ["sh", "scripts/start-render.sh"]

FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt "psycopg[binary]>=3.1"
COPY backend/ /app/
COPY data/ /data/
ENV OFFLIMITS_DATA_DIR=/data PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]

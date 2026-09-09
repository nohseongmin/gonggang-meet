FROM python:3.12-slim

WORKDIR /code

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# SQLite 파일은 /data 볼륨에 저장 — 컨테이너를 재빌드해도 데이터 유지
ENV GONGGANG_DB=/data/gonggang.db
RUN useradd --create-home appuser && mkdir -p /data && chown appuser /data
USER appuser
VOLUME /data

EXPOSE 8377
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8377"]

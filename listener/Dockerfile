FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
# Persist the Telegram session across restarts if the host gives a volume at /data
ENV SESSION_FILE=/data/user_session
CMD ["python", "app.py"]

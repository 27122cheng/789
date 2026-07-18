FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
# Login persists via the SESSION_STRING env var (shown on the status page
# after first login), so no disk volume is needed - restarts stay logged in.
CMD ["python", "app.py"]

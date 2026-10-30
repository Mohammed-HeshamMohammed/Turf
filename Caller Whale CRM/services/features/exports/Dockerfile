FROM python:3.13-slim
WORKDIR /app
COPY server.py ./
ENV PORT=8117
EXPOSE 8117
USER nobody
CMD ["python", "server.py"]

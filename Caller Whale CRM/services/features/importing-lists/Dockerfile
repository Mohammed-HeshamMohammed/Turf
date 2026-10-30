FROM python:3.13-slim
WORKDIR /app
COPY server.py ./
ENV PORT=8111
EXPOSE 8111
USER nobody
CMD ["python", "server.py"]

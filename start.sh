docker stop lina-router
docker rm lina-router
docker build -t lina-router .
docker run -d --name lina-router -p 20128:20128 --env-file .env -v lina-router-data:/app/data lina-router
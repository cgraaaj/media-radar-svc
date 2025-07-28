# Media Radar Backend - Deployment Guide

This guide will help you deploy the Media Radar backend using Docker and Docker Compose.

## 🚀 Quick Start

### Prerequisites

- Docker Engine 20.10+
- Docker Compose 2.0+
- Node.js 18+ (for local development)

### 1. Environment Setup

First, create your environment configuration:

```bash
# Copy the environment template
cp env.template .env

# Edit the .env file with your actual values
nano .env
```

**Important:** Update these values in your `.env` file:
- `REDIS_PASSWORD`: Use a secure password
- `TMDB_API_KEY`: Get from https://www.themoviedb.org/settings/api
- `TMDB_ACCESS_TOKEN`: Get from TMDB API settings
- `OMDB_API_KEY`: Get from http://www.omdbapi.com/apikey.aspx
- `JWT_SECRET` & `SESSION_SECRET`: Generate secure random strings

### 2. Deploy with Docker Compose

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Check service status
docker-compose ps
```

### 3. Deploy Backend Only

```bash
# Build the Docker image
docker build -t media-radar-backend .

# Run the container
docker run -d \
  --name media-radar-backend \
  -p 5000:5000 \
  --env-file .env \
  media-radar-backend
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `NODE_ENV` | Environment mode | `production` | No |
| `PORT` | Server port | `5000` | No |
| `HOST` | Server host | `0.0.0.0` | No |
| `REDIS_HOST` | Redis server host | `192.168.1.72` | Yes |
| `REDIS_PORT` | Redis server port | `6379` | No |
| `REDIS_PASSWORD` | Redis password | - | Yes |
| `TMDB_API_KEY` | TMDB API key | - | Yes |
| `TMDB_ACCESS_TOKEN` | TMDB access token | - | Yes |
| `OMDB_API_KEY` | OMDB API key | - | Yes |
| `ALLOWED_ORIGINS` | CORS origins (comma-separated) | `http://localhost:3000` | No |

### API Keys Setup

#### TMDB API Key
1. Create account at https://www.themoviedb.org/
2. Go to Settings → API
3. Request API key
4. Copy both API Key and Access Token

#### OMDB API Key
1. Visit http://www.omdbapi.com/apikey.aspx
2. Choose free tier (1000 requests/day)
3. Verify email and get API key

## 🐳 Docker Commands

```bash
# Build image
docker build -t media-radar-backend .

# Run container
docker run -d -p 5000:5000 --env-file .env media-radar-backend

# View logs
docker logs media-radar-backend

# Stop container
docker stop media-radar-backend

# Remove container
docker rm media-radar-backend
```

## 🔍 Health Checks

The application includes built-in health checks:

```bash
# Check application health
curl http://localhost:5000/api/health

# Check Redis connection
curl http://localhost:5000/api/redis-status
```

## 🚀 Production Deployment

### Using Docker Compose in Production

```bash
# Use production compose file
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Environment-Specific Configurations

Create environment-specific files:
- `.env.development`
- `.env.staging`
- `.env.production`

### Security Considerations

1. **Change default passwords**
2. **Use environment-specific secrets**
3. **Enable SSL/TLS in production**
4. **Set up proper firewall rules**
5. **Use Docker secrets for sensitive data**

## 📊 Monitoring

### Container Stats
```bash
docker stats media-radar-backend
```

### Application Logs
```bash
# Follow logs
docker logs -f media-radar-backend

# Last 100 lines
docker logs --tail 100 media-radar-backend
```

## 🛠 Troubleshooting

### Common Issues

**Redis Connection Failed**
```bash
# Check Redis container
docker-compose logs redis

# Test Redis connection
docker-compose exec redis redis-cli ping
```

**API Key Issues**
```bash
# Check environment variables
docker-compose exec backend printenv | grep API
```

**Port Already in Use**
```bash
# Check what's using port 5000
sudo lsof -i :5000

# Or change port in .env file
PORT=5001
```

### Reset Everything
```bash
# Stop and remove all containers
docker-compose down

# Remove volumes (this will delete Redis data!)
docker-compose down -v

# Rebuild and restart
docker-compose up -d --build
```

## 📈 Scaling

### Horizontal Scaling
```bash
# Scale backend to 3 instances
docker-compose up -d --scale backend=3
```

### Load Balancer Configuration
Add nginx or traefik as reverse proxy for multiple backend instances.

## 🔄 Updates

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose up -d --build

# Or rebuild specific service
docker-compose up -d --build backend
```

---

## 📞 Support

For issues and questions:
1. Check the logs: `docker-compose logs`
2. Verify environment variables
3. Ensure API keys are valid
4. Check Redis connection 
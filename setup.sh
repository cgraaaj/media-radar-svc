#!/bin/bash

# Media Radar Backend Setup Script
# This script helps you set up the backend for deployment

set -e

echo "🎬 Media Radar Backend Setup"
echo "=============================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Docker is installed
check_docker() {
    print_status "Checking Docker installation..."
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed. Please install Docker first."
        exit 1
    fi
    print_success "Docker is installed"
}

# Check if Docker Compose is installed
check_docker_compose() {
    print_status "Checking Docker Compose installation..."
    if ! command -v docker-compose &> /dev/null; then
        print_error "Docker Compose is not installed. Please install Docker Compose first."
        exit 1
    fi
    print_success "Docker Compose is installed"
}

# Create .env file from template
setup_env() {
    print_status "Setting up environment file..."
    
    if [ -f ".env" ]; then
        print_warning ".env file already exists. Backing up to .env.backup"
        cp .env .env.backup
    fi
    
    cp env.template .env
    print_success "Created .env file from template"
    print_warning "Please edit .env file with your actual API keys and configuration!"
    
    echo ""
    echo "Required API Keys:"
    echo "- TMDB API Key: https://www.themoviedb.org/settings/api"
    echo "- OMDB API Key: http://www.omdbapi.com/apikey.aspx"
    echo ""
}

# Build Docker image
build_image() {
    print_status "Building Docker image..."
    docker build -t media-radar-backend .
    print_success "Docker image built successfully"
}

# Start services with Docker Compose
start_services() {
    print_status "Starting services with Docker Compose..."
    docker-compose up -d
    print_success "Services started successfully"
    
    echo ""
    print_status "Waiting for services to be ready..."
    sleep 10
    
    # Check if services are running
    if docker-compose ps | grep -q "Up"; then
        print_success "Services are running!"
        echo ""
        echo "🌐 Backend URL: http://localhost:5000"
        echo "📊 Health Check: http://localhost:5000/api/health"
        echo "📈 Redis Status: http://localhost:5000/api/redis-status"
        echo ""
        echo "📋 View logs: docker-compose logs -f"
        echo "🛑 Stop services: docker-compose down"
    else
        print_error "Some services failed to start. Check logs with: docker-compose logs"
    fi
}

# Show help
show_help() {
    echo ""
    echo "Usage: $0 [OPTION]"
    echo ""
    echo "Options:"
    echo "  --check-only    Only check prerequisites"
    echo "  --env-only      Only setup environment file"
    echo "  --build-only    Only build Docker image"
    echo "  --start-only    Only start services"
    echo "  --help          Show this help message"
    echo ""
    echo "With no options, runs complete setup"
}

# Main execution
main() {
    case "${1:-}" in
        --check-only)
            check_docker
            check_docker_compose
            ;;
        --env-only)
            setup_env
            ;;
        --build-only)
            check_docker
            build_image
            ;;
        --start-only)
            check_docker
            check_docker_compose
            start_services
            ;;
        --help)
            show_help
            ;;
        "")
            # Full setup
            check_docker
            check_docker_compose
            setup_env
            build_image
            start_services
            
            echo ""
            print_success "Setup completed successfully!"
            print_warning "Don't forget to update your .env file with actual API keys!"
            ;;
        *)
            print_error "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
}

# Run main function with all arguments
main "$@" 
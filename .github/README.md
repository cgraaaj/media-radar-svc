# GitHub Actions CI/CD Configuration

This directory contains GitHub Actions workflows and templates for the Media Radar Backend project.

## 🚀 Workflows

### `deploy.yaml` - CI/CD Pipeline
Automatically builds, tests, and deploys the backend application when code is pushed to main/master branches.

**Features:**
- ✅ Runs tests and linting
- 🐳 Builds multi-platform Docker images (linux/amd64, linux/arm64)
- 📦 Pushes images to Harbor registry
- ⚡ Updates Helm charts (optional)
- 🚀 Deploys via Docker Compose (optional)

## 🔧 Required GitHub Secrets

Configure these secrets in your GitHub repository settings:

| Secret Name | Description | Required |
|-------------|-------------|----------|
| `HARBOR_USERNAME` | Harbor registry username | ✅ Yes |
| `HARBOR_PASSWORD` | Harbor registry password | ✅ Yes |
| `GIT_SSH_PRIVATE_KEY` | SSH key for Helm repo access | 🔄 If using Helm |
| `DEPLOY_HOST` | Deployment server hostname/IP | 🔄 If using Docker Compose deploy |
| `DEPLOY_USER` | Deployment server username | 🔄 If using Docker Compose deploy |
| `DEPLOY_SSH_KEY` | SSH key for deployment server | 🔄 If using Docker Compose deploy |

## 📝 Configuration

### Update Environment Variables
Edit the `env` section in `deploy.yaml`:

```yaml
env:
  HELM_REPO: "git@github.com:your-username/media-radar-k8s.git"  # Your Helm repo
  IMAGE_REGISTRY: "registry.cgraaaj.in"  # Your registry URL
  IMAGE_NAME: "media-radar-backend"  # Your image name
```

### Helm Repository (Optional)
If using Kubernetes with Helm:
1. Create a separate repository for Helm charts
2. Update `HELM_REPO` environment variable
3. Ensure your Helm chart has the correct structure:
   ```
   backend/
   ├── Chart.yaml
   └── values.yaml
   ```

### Docker Compose Deployment (Optional)
If using Docker Compose deployment:
1. Update the deployment path in the workflow
2. Ensure your server has Docker and Docker Compose installed
3. Set up the required SSH secrets

## 📋 Issue Templates

### Bug Report (`ISSUE_TEMPLATE/bug_report.md`)
Template for reporting bugs with structured information including:
- Bug description
- Steps to reproduce
- Environment details
- API details (if applicable)

### Feature Request (`ISSUE_TEMPLATE/feature_request.md`)
Template for requesting new features with:
- Feature description
- Problem statement
- Acceptance criteria
- Technical considerations

## 📄 Pull Request Template

The PR template (`pull_request_template.md`) ensures consistent information:
- Change description and type
- Testing checklist
- Code review checklist
- Related issues

## 🎯 Usage

1. **Setup Secrets**: Configure all required secrets in GitHub repository settings
2. **Update Configuration**: Modify environment variables in `deploy.yaml`
3. **Create Pull Request**: Use the PR template for consistent reviews
4. **Report Issues**: Use issue templates for bugs and feature requests
5. **Push to Main**: Automatic deployment will trigger on main branch pushes

## 🔍 Troubleshooting

### Build Failures
- Check Docker buildx setup
- Verify registry credentials
- Ensure Dockerfile is in the correct location

### Deployment Failures
- Verify SSH access to deployment server
- Check Docker Compose file syntax
- Ensure all required environment variables are set

### Helm Updates (if applicable)
- Verify SSH key has access to Helm repository
- Check Helm chart structure
- Ensure Chart.yaml and values.yaml exist 
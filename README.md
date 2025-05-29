# Cloudflare Pages Deployment Cleanup Action

This GitHub Action automatically cleans up old or orphaned deployments from your Cloudflare Pages project. It helps you manage your Cloudflare Pages deployments by deleting preview deployments for deleted branches and keeping only a specified number of the most recent deployments for each branch and production.

## Features
- Deletes preview deployments for branches that no longer exist in your repository.
- Keeps only the N most recent preview deployments per branch (configurable).
- Keeps only the N most recent production deployments (configurable).
- Supports dry-run mode to preview what would be deleted.
- Provides a summary of actions in the GitHub Actions workflow summary.

## Required Permissions

The action requires the following permissions for the `GITHUB_TOKEN`:

```yaml
permissions:
  contents: read  # To list branches in the repository
```

If you use a custom token, ensure it has at least `repo` scope for private repositories.

## Inputs

| Name                  | Description                                                      | Required | Default   |
|-----------------------|------------------------------------------------------------------|----------|-----------|
| cloudflare-api-token  | Cloudflare API token with access to Pages deployments             | true     |           |
| cloudflare-account-id | Cloudflare Account ID                                             | true     |           |
| cloudflare-project-name | Cloudflare Pages project name                                   | true     |           |
| github-token          | GitHub token (defaults to `secrets.GITHUB_TOKEN`)                | false    |           |
| cleanup-types         | Which deployments to clean: `preview`, `production`, or `all`    | false    | preview   |
| preview-keep          | Number of preview deployments to keep per branch                 | false    | 1         |
| production-keep       | Number of production deployments to keep                         | false    | 1         |
| dry-run               | If `true`, no deployments are deleted (for testing)              | false    | false     |

## Usage

### Minimal Example

```yaml
name: Cleanup Cloudflare Pages Deployments
on:
  workflow_dispatch:
  schedule:
    - cron: '0 3 * * *'  # Every day at 3am UTC

permissions:
  contents: read

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Cleanup Cloudflare Pages Deployments
        uses: ./  # or use the repository path if published
        with:
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          cloudflare-account-id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          cloudflare-project-name: ${{ secrets.CLOUDFLARE_PAGE_NAME }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Advanced Example (All Options)

```yaml
name: Cleanup Cloudflare Pages Deployments
on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Cleanup Cloudflare Pages Deployments
        uses: ./
        with:
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          cloudflare-account-id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          cloudflare-project-name: ${{ secrets.CLOUDFLARE_PAGE_NAME }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          cleanup-types: all
          preview-keep: 2
          production-keep: 3
          dry-run: 'true'
```

## Cloudflare API Token Requirements

The Cloudflare API token must have permissions for **Pages:Edit** on the relevant account.

## Output

- The action prints a summary table of kept deployments and a count of deleted deployments in the workflow summary.
- In dry-run mode, no deployments are deleted; the action only prints what would be deleted.

## License

MIT

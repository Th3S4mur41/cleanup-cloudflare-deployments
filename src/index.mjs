import * as core from '@actions/core';
import * as github from '@actions/github';
import fetch from 'node-fetch';

async function run() {
  try {
    // Inputs
    const apiToken = core.getInput('cloudflare-api-token');
    const accountId = core.getInput('cloudflare-account-id');
    const projectName = core.getInput('cloudflare-project-name');
    let githubToken = core.getInput('github-token');
    if (!githubToken) {
      githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        core.setFailed('No GitHub token provided and secrets.GITHUB_TOKEN is missing from environment.');
        return;
      }
    }
    const cleanupType = (core.getInput('cleanup-types') || 'preview').trim().toLowerCase();
    const previewKeep = parseInt(core.getInput('preview-keep') || '1', 10);
    const productionKeep = parseInt(core.getInput('production-keep') || '1', 10);

    // Validate cleanupType
    if (!['preview', 'production', 'all'].includes(cleanupType)) {
      core.setFailed("cleanup-types must be one of: 'preview', 'production', or 'all'");
      return;
    }

    // GitHub context
    const octokit = github.getOctokit(githubToken);
    const { owner, repo } = github.context.repo;

    // Get all branches from GitHub
    const branches = await octokit.paginate(octokit.rest.repos.listBranches, {
      owner,
      repo,
      per_page: 100,
    });
    const branchNames = new Set(branches.map(b => b.name));

    // Get all deployments from Cloudflare
    const deployments = await fetchAllDeployments({ apiToken, accountId, projectName });

    // Group deployments
    const previewDeployments = deployments.filter(d => d.environment === 'preview');
    const productionDeployments = deployments.filter(d => d.environment === 'production');

    // Cleanup PREVIEW deployments
    if (cleanupType === 'preview' || cleanupType === 'all') {
      // 1. Delete previews for deleted branches
      for (const d of previewDeployments) {
        const branch = d.deployment_trigger?.metadata?.branch;
        if (branch && !branchNames.has(branch)) {
          await deleteDeployment({ apiToken, accountId, projectName, id: d.id });
          core.info(`Deleted preview deployment ${d.id} for deleted branch ${branch}`);
        }
      }
      // 2. For existing branches, keep only the N most recent
      const previewsByBranch = {};
      previewDeployments.forEach(d => {
        const branch = d.deployment_trigger?.metadata?.branch;
        if (!branch) return;
        previewsByBranch[branch] = previewsByBranch[branch] || [];
        previewsByBranch[branch].push(d);
      });
      for (const branch in previewsByBranch) {
        const sorted = previewsByBranch[branch].sort((a, b) => new Date(b.created_on) - new Date(a.created_on));
        const toDelete = sorted.slice(previewKeep);
        for (const d of toDelete) {
          await deleteDeployment({ apiToken, accountId, projectName, id: d.id });
          core.info(`Deleted old preview deployment ${d.id} for branch ${branch}`);
        }
      }
    }

    // Cleanup PRODUCTION deployments
    if (cleanupType === 'production' || cleanupType === 'all') {
      const sorted = productionDeployments.sort((a, b) => new Date(b.created_on) - new Date(a.created_on));
      const toDelete = sorted.slice(productionKeep);
      for (const d of toDelete) {
        await deleteDeployment({ apiToken, accountId, projectName, id: d.id });
        core.info(`Deleted old production deployment ${d.id}`);
      }
    }

    core.info('Cleanup complete!');
  } catch (err) {
    core.setFailed(err.message);
  }
}

// Helper: get all deployments
async function fetchAllDeployments({ apiToken, accountId, projectName }) {
  let deployments = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments?page=${page}&per_page=100`,
      {
        headers: { Authorization: `Bearer ${apiToken}` },
      }
    );
    const data = await res.json();
    if (!data.success) throw new Error('Failed to fetch Cloudflare deployments');
    deployments = deployments.concat(data.result);
    if (data.result.length < 100) break;
    page++;
  }
  return deployments;
}

// Helper: delete deployment
async function deleteDeployment({ apiToken, accountId, projectName, id }) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments/${id}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` },
    }
  );
  if (!res.ok) throw new Error(`Failed to delete deployment ${id}`);
}

run();
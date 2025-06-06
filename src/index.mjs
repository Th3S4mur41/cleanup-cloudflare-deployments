import fs from 'node:fs';
import * as core from '@actions/core';
import * as github from '@actions/github';
import fetch from 'node-fetch';

async function run() {
	try {
		// Inputs
		const apiToken = core.getInput('cloudflare-api-token');
		const accountId = core.getInput('cloudflare-account-id');
		const projectName = core.getInput('cloudflare-project-name');
		const githubToken = core.getInput('github-token') || process.env.GITHUB_TOKEN;
		if (!githubToken) {
			core.setFailed('No GitHub token provided and secrets.GITHUB_TOKEN is missing from environment.');
			return;
		}
		const cleanupType = (core.getInput('cleanup-types') || 'preview').trim().toLowerCase();
		const previewKeep = Number.parseInt(core.getInput('preview-keep') || '1', 10);
		const productionKeep = Number.parseInt(core.getInput('production-keep') || '1', 10);
		const dryRun = core.getInput('dry-run') === 'true';

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
		const branchNames = new Set(branches.map((b) => b.name));

		// Get all deployments from Cloudflare
		const deployments = await fetchAllDeployments({ apiToken, accountId, projectName });

		// Group deployments
		const previewDeployments = deployments.filter((d) => d.environment === 'preview');
		const productionDeployments = deployments.filter((d) => d.environment === 'production');

		// Track deleted and kept deployments for summary
		let deletedPreviewCount = 0;
		let deletedProductionCount = 0;
		const keptDeployments = [];

		// Cleanup PREVIEW deployments
		if (cleanupType === 'preview' || cleanupType === 'all') {
			// 1. Delete previews for deleted branches
			for (const d of previewDeployments) {
				const branch = d.deployment_trigger?.metadata?.branch;
				const wouldDelete = branch && !branchNames.has(branch);
				if (dryRun) {
					printDeploymentRow(d, 'preview', branch, wouldDelete ? 'DELETE' : 'KEEP');
					if (!wouldDelete) keptDeployments.push({ d, env: 'preview', branch });
				} else if (wouldDelete) {
					try {
						await deleteDeployment({ apiToken, accountId, projectName, id: d.id });
						printDeploymentRow(d, 'preview', branch, 'DELETED');
						deletedPreviewCount++;
					} catch (err) {
						printDeploymentRow(d, 'preview', branch, 'ERROR');
						core.error(`Failed to delete deployment ${d.id}: ${err.message}`);
					}
				} else {
					printDeploymentRow(d, 'preview', branch, 'KEEP');
					keptDeployments.push({ d, env: 'preview', branch });
				}
			}
			// 2. For existing branches, keep only the N most recent
			const previewsByBranch = {};
			// biome-ignore lint/complexity/noForEach: Using forEach for async operations
			previewDeployments.forEach((d) => {
				const branch = d.deployment_trigger?.metadata?.branch;
				if (!branch) return;
				previewsByBranch[branch] = previewsByBranch[branch] || [];
				previewsByBranch[branch].push(d);
			});
			for (const branch in previewsByBranch) {
				const sorted = previewsByBranch[branch].sort((a, b) => new Date(b.created_on) - new Date(a.created_on));
				for (let idx = 0; idx < sorted.length; idx++) {
					const d = sorted[idx];
					const wouldDelete = idx >= previewKeep;
					if (dryRun) {
						printDeploymentRow(d, 'preview', branch, wouldDelete ? 'DELETE' : 'KEEP');
						if (!wouldDelete) keptDeployments.push({ d, env: 'preview', branch });
					} else if (wouldDelete) {
						try {
							await deleteDeployment({ apiToken, accountId, projectName, id: d.id });
							printDeploymentRow(d, 'preview', branch, 'DELETED');
							deletedPreviewCount++;
						} catch (err) {
							printDeploymentRow(d, 'preview', branch, 'ERROR');
							core.error(`Failed to delete deployment ${d.id}: ${err.message}`);
						}
					} else {
						printDeploymentRow(d, 'preview', branch, 'KEEP');
						keptDeployments.push({ d, env: 'preview', branch });
					}
				}
			}
		}

		// Cleanup PRODUCTION deployments
		if (cleanupType === 'production' || cleanupType === 'all') {
			const sorted = productionDeployments.sort((a, b) => new Date(b.created_on) - new Date(a.created_on));
			for (let idx = 0; idx < sorted.length; idx++) {
				const d = sorted[idx];
				const wouldDelete = idx >= productionKeep;
				if (dryRun) {
					printDeploymentRow(d, 'production', null, wouldDelete ? 'DELETE' : 'KEEP');
					if (!wouldDelete) keptDeployments.push({ d, env: 'production', branch: null });
				} else if (wouldDelete) {
					try {
						await deleteDeployment({ apiToken, accountId, projectName, id: d.id });
						printDeploymentRow(d, 'production', null, 'DELETED');
						deletedProductionCount++;
					} catch (err) {
						printDeploymentRow(d, 'production', null, 'ERROR');
						core.error(`Failed to delete deployment ${d.id}: ${err.message}`);
					}
				} else {
					printDeploymentRow(d, 'production', null, 'KEEP');
					keptDeployments.push({ d, env: 'production', branch: null });
				}
			}
		}

		if (dryRun) {
			core.info('Dry run complete! No deployments were deleted.');
		} else {
			core.info('Cleanup complete!');
		}

		// Write workflow summary
		await writeWorkflowSummary({
			deletedPreviewCount,
			deletedProductionCount,
			keptDeployments,
			accountId,
			projectName,
		});
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
			`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments?page=${page}`,
			{
				headers: { Authorization: `Bearer ${apiToken}` },
			},
		);
		const data = await res.json();
		if (!data.success) {
			core.error(`Cloudflare API error: ${JSON.stringify(data.errors)}`);
			throw new Error('Failed to fetch Cloudflare deployments');
		}
		deployments = deployments.concat(data.result);
		if (data.result.length < 25) break;
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
		},
	);
	if (!res.ok) throw new Error(`Failed to delete deployment ${id}`);
}

// Helper: print deployment info in columns
function printDeploymentRow(d, env, branch, status) {
	const id = d.id.padEnd(36);
	const envStr = env.padEnd(10);
	// For production, try to get branch from deployment_trigger if available, else empty string
	let branchStr = branch;
	if (!branchStr && d.deployment_trigger?.metadata?.branch) {
		branchStr = d.deployment_trigger.metadata.branch;
	}
	branchStr = (branchStr || '').padEnd(20);
	// Get commit sha (short)
	const sha = d.deployment_trigger?.metadata?.commit_hash || '';
	const shaShort = sha ? sha.substring(0, 7) : '';
	const shaStr = shaShort.padEnd(10);
	const created = new Date(d.created_on).toISOString().slice(0, 19).replace('T', ' ');
	core.info(`${id}  ${envStr}  ${branchStr}  ${shaStr}  ${created}  ${status}`);
}

async function writeWorkflowSummary({
	deletedPreviewCount,
	deletedProductionCount,
	keptDeployments,
	accountId,
	projectName,
}) {
	let summary = '';
	if (deletedProductionCount > 0) {
		summary += `- Deleted **${deletedProductionCount}** production deployment(s)\n`;
	}
	if (deletedPreviewCount > 0) {
		summary += `- Deleted **${deletedPreviewCount}** preview deployment(s)\n`;
	}
	if (keptDeployments.length > 0) {
		summary += '\n### Kept Deployments\n';
		summary += '| ID | Environment | Branch | Commit | Created | Status |\n';
		summary += '| --- | --- | --- | --- | --- | --- |\n';
		// Get repo info for commit links
		const owner = process.env.GITHUB_REPOSITORY?.split('/')[0] || '';
		const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || '';
		for (const { d, env, branch } of keptDeployments) {
			let branchStr = branch;
			if (!branchStr && d.deployment_trigger?.metadata?.branch) {
				branchStr = d.deployment_trigger.metadata.branch;
			}
			const sha = d.deployment_trigger?.metadata?.commit_hash || '';
			const shaShort = sha ? sha.substring(0, 7) : '';
			const shaLink =
				sha && owner && repo ? `[${shaShort}](https://github.com/${owner}/${repo}/commit/${sha})` : shaShort;
			const id = d.id;
			// Cloudflare deployment details link
			const cfLink = `https://dash.cloudflare.com/${accountId}/pages/view/${projectName}/${id}`;
			const idLink = `[${id}](${cfLink})`;
			const created = new Date(d.created_on).toISOString().slice(0, 19).replace('T', ' ');
			summary += `| ${idLink} | ${env} | ${branchStr || ''} | ${shaLink} | ${created} | KEEP |\n`;
		}
	}
	// Write to GitHub Actions summary if available
	if (process.env.GITHUB_STEP_SUMMARY) {
		fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
	} else {
		core.info(`\n--- Workflow Summary ---\n ${summary}`);
	}
}

run();

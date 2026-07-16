import type { ProjectBundle, ProjectSettings } from "../../shared/schema";
import { mcpServerSchema } from "../../shared/schema";
import type { CreateProjectSkillInput, McpImportSource, McpRefreshResult, McpRegistryInstallInput, McpRegistryInstallResult, McpRegistrySearchInput, McpRegistrySearchResult, ProjectSkill } from "../../shared/capabilities";
import { iso } from "./persistence";
import { checkProviderHealth, type ProviderHealthResult } from "../providers";
import { createProjectSkill as writeProjectSkill, listProjectSkills as readProjectSkills } from "../skills";
import { importMcpServers, listMcpRegistryServers, mcpServerFromRegistryEntry, refreshMcpServerCapabilities } from "../mcp";
import { hydrateProviderForUse, loadProject, updateProjectSettings } from "./projectStore";

export async function checkProjectProvider(projectRoot: string, providerId: string): Promise<ProviderHealthResult> {
  const bundle = await loadProject(projectRoot);
  const provider = bundle.project.settings.providers.find((item) => item.id === providerId);
  if (!provider) {
    return {
      providerId,
      ok: false,
      status: "failed",
      checkedAt: iso(),
      message: `Provider ${providerId} was not found.`
    };
  }
  const health = await checkProviderHealth(await hydrateProviderForUse(provider));
  if (health.detectedContextWindowTokens || health.availableModels?.length || health.detectedOpenAiEndpointMode) {
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((item) => item.id === providerId
          ? {
              ...item,
              detectedContextWindowTokens: health.detectedContextWindowTokens ?? item.detectedContextWindowTokens,
              detectedAvailableModels: health.availableModels?.length ? health.availableModels : item.detectedAvailableModels,
              detectedModelCapabilities: health.detectedModelCapabilities && Object.keys(health.detectedModelCapabilities).length
                ? health.detectedModelCapabilities
                : item.detectedModelCapabilities,
              detectedOpenAiEndpointMode: health.detectedOpenAiEndpointMode ?? item.detectedOpenAiEndpointMode
            }
        : item)
    });
  }
  return health;
}

export async function listProjectSkills(projectRoot: string): Promise<ProjectSkill[]> {
  const bundle = await loadProject(projectRoot);
  return readProjectSkills(projectRoot, bundle.project.settings);
}

export async function createProjectSkill(projectRoot: string, input: CreateProjectSkillInput): Promise<ProjectSkill[]> {
  await writeProjectSkill(projectRoot, input);
  return listProjectSkills(projectRoot);
}

export async function listMcpServers(projectRoot: string): Promise<ProjectSettings["mcp"]["servers"]> {
  const bundle = await loadProject(projectRoot);
  return bundle.project.settings.mcp.servers;
}

export async function updateMcpServer(projectRoot: string, server: ProjectSettings["mcp"]["servers"][number]): Promise<ProjectBundle> {
  const bundle = await loadProject(projectRoot);
  const parsed = mcpServerSchema.parse(server);
  const exists = bundle.project.settings.mcp.servers.some((item) => item.id === parsed.id);
  return updateProjectSettings(projectRoot, {
    ...bundle.project.settings,
    mcp: {
      ...bundle.project.settings.mcp,
      servers: exists
        ? bundle.project.settings.mcp.servers.map((item) => item.id === parsed.id ? parsed : item)
        : [...bundle.project.settings.mcp.servers, parsed]
    }
  });
}

export async function importProjectMcpServers(projectRoot: string, source: McpImportSource): Promise<ProjectBundle> {
  const bundle = await loadProject(projectRoot);
  const imported = await importMcpServers(source);
  const byId = new Map(bundle.project.settings.mcp.servers.map((server) => [server.id, server]));
  for (const server of imported) {
    byId.set(server.id, {
      ...server,
      ...byId.get(server.id),
      source: server.source
    });
  }
  return updateProjectSettings(projectRoot, {
    ...bundle.project.settings,
    mcp: {
      ...bundle.project.settings.mcp,
      servers: [...byId.values()]
    }
  });
}

export async function searchMcpRegistry(input: McpRegistrySearchInput): Promise<McpRegistrySearchResult> {
  return listMcpRegistryServers(input);
}

export async function installProjectMcpRegistryServer(projectRoot: string, input: McpRegistryInstallInput): Promise<McpRegistryInstallResult> {
  const server = mcpServerFromRegistryEntry(input);
  await updateMcpServer(projectRoot, server);
  if (input.refresh && server.enabled && !server.lastError) {
    const refresh = await refreshProjectMcpServerCapabilities(projectRoot, server.id);
    return {
      server: refresh.server,
      refresh,
      message: refresh.ok ? `Installed and connected ${refresh.server.label}.` : `Installed ${server.label}, but refresh failed: ${refresh.message}`
    };
  }
  return {
    server,
    message: server.lastError ? `Installed ${server.label}. ${server.lastError}` : `Installed ${server.label}.`
  };
}

export async function refreshProjectMcpServerCapabilities(projectRoot: string, serverId: string): Promise<McpRefreshResult> {
  const bundle = await loadProject(projectRoot);
  const server = bundle.project.settings.mcp.servers.find((item) => item.id === serverId);
  if (!server) throw new Error(`MCP server ${serverId} was not found.`);
  const result = await refreshMcpServerCapabilities(server);
  await updateMcpServer(projectRoot, result.server);
  return result;
}

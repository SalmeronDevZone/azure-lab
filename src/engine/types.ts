// Modelo de datos de la nube simulada. Sigue la forma de Azure Resource Manager (ARM).

export type Tags = Record<string, string>;

export interface Subscription {
  id: string;
  displayName: string;
  state: 'Enabled' | 'Disabled';
  tenantId: string;
  offer: string;
}

export interface ResourceGroup {
  id: string;
  name: string;
  location: string;
  tags: Tags;
  subscriptionId: string;
  managedBy?: string | null;
  provisioningState: 'Succeeded' | 'Deleting';
  createdAt: string;
}

export interface Sku {
  name: string;
  tier?: string;
  capacity?: number;
  family?: string;
  size?: string;
}

export interface Identity {
  type: 'SystemAssigned' | 'UserAssigned' | 'SystemAssigned, UserAssigned' | 'None';
  principalId?: string;
  tenantId?: string;
  userAssignedIdentities?: Record<string, { principalId: string; clientId: string }>;
}

export interface Resource {
  id: string;
  name: string;
  type: string;
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  tags: Tags;
  kind?: string;
  sku?: Sku;
  identity?: Identity;
  zones?: string[];
  managedBy?: string;
  properties: Record<string, any>;
  /** Estado de plano de datos / runtime que no forma parte de la representación ARM. */
  data?: Record<string, any>;
  createdAt: string;
  createdBy?: string;
}

export interface ActivityLogEntry {
  id: string;
  time: string;
  operationName: string;
  operationNameValue: string;
  status: 'Started' | 'Succeeded' | 'Failed' | 'Accepted';
  caller: string;
  resourceId: string;
  resourceGroup?: string;
  resourceType?: string;
  subscriptionId: string;
  level: 'Informational' | 'Error' | 'Warning' | 'Critical';
  category: 'Administrative' | 'Policy' | 'Security' | 'ServiceHealth' | 'Alert' | 'Autoscale';
  message?: string;
  correlationId: string;
}

export type PrincipalType = 'User' | 'Group' | 'ServicePrincipal';

export interface PrincipalRef {
  type: 'User' | 'ServicePrincipal';
  objectId: string;
  /** UPN para usuarios, appId para service principals */
  name: string;
  displayName: string;
}

export interface EntraUser {
  id: string;
  displayName: string;
  userPrincipalName: string;
  mail?: string | null;
  password: string;
  accountEnabled: boolean;
  jobTitle?: string | null;
  department?: string | null;
  userType: 'Member' | 'Guest';
  createdAt: string;
}

export interface EntraGroup {
  id: string;
  displayName: string;
  mailNickname: string;
  description?: string | null;
  members: string[];
  securityEnabled: boolean;
  createdAt: string;
}

export interface AppRegistration {
  id: string;
  appId: string;
  displayName: string;
  createdAt: string;
  passwordCredentials: { keyId: string; displayName: string; hint: string; endDateTime: string }[];
  federatedCredentials: { name: string; issuer: string; subject: string }[];
}

export interface ServicePrincipal {
  id: string;
  appId: string;
  displayName: string;
  servicePrincipalType: 'Application' | 'ManagedIdentity';
  /** secretos válidos (sólo aplicaciones) */
  secrets: string[];
  /** recurso asociado a una identidad administrada */
  alternativeNames?: string[];
  createdAt: string;
}

export interface Permission {
  actions: string[];
  notActions: string[];
  dataActions: string[];
  notDataActions: string[];
}

export interface RoleDefinition {
  id: string;
  name: string;
  roleName: string;
  description: string;
  roleType: 'BuiltInRole' | 'CustomRole';
  permissions: Permission[];
  assignableScopes: string[];
}

export interface RoleAssignment {
  id: string;
  name: string;
  principalId: string;
  principalType: PrincipalType;
  principalName: string;
  roleDefinitionId: string;
  roleDefinitionName: string;
  scope: string;
  createdOn: string;
  createdBy: string;
}

export interface Lock {
  id: string;
  name: string;
  level: 'CanNotDelete' | 'ReadOnly';
  notes?: string;
  scope: string;
}

export interface PolicyAssignment {
  id: string;
  name: string;
  displayName: string;
  scope: string;
  policyDefinitionId: string;
  parameters: Record<string, { value: any }>;
  enforcementMode: 'Default' | 'DoNotEnforce';
  createdAt: string;
}

export interface Deployment {
  id: string;
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  provisioningState: 'Accepted' | 'Running' | 'Succeeded' | 'Failed' | 'Canceled';
  timestamp: string;
  duration?: string;
  mode: 'Incremental' | 'Complete';
  templateHash?: string;
  parameters: Record<string, any>;
  outputs: Record<string, { type: string; value: any }>;
  outputResources: { id: string; status?: string }[];
  error?: { code: string; message: string };
  source: 'portal' | 'cli' | 'pipeline' | 'terraform';
  template?: any;
}

export interface DeletedVault {
  name: string;
  id: string;
  location: string;
  deletionDate: string;
  scheduledPurgeDate: string;
  resource: Resource;
}

export interface PortalNotification {
  id: string;
  title: string;
  message: string;
  time: string;
  level: 'info' | 'success' | 'error' | 'warning' | 'progress';
  read: boolean;
  link?: string;
  deploymentId?: string;
}

export interface AlertInstance {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: number;
  targetResource: string;
  description: string;
  firedAt: string;
  resolvedAt?: string;
  state: 'Fired' | 'Resolved';
  metricValue: number;
  condition: string;
}

export interface SimEmail {
  id: string;
  to: string;
  subject: string;
  body: string;
  time: string;
  read: boolean;
}

/** Eventos de telemetría usados por métricas, logs y validaciones. */
export interface SimEvent {
  t: number;
  kind:
    | 'http'
    | 'secretGet'
    | 'blobOp'
    | 'vmCmd'
    | 'k8s'
    | 'sqlConn'
    | 'login'
    | 'pipeline'
    | 'cost';
  resourceId?: string;
  status?: number;
  detail?: string;
  caller?: string;
  durationMs?: number;
  path?: string;
}

export interface DiagnosticSetting {
  id: string;
  name: string;
  resourceUri: string;
  workspaceId?: string;
  storageAccountId?: string;
  logs: { category?: string; categoryGroup?: string; enabled: boolean }[];
  metrics: { category: string; enabled: boolean }[];
  createdAt: string;
}

export interface Budget {
  id: string;
  name: string;
  amount: number;
  scope: string;
  timeGrain: 'Monthly';
  thresholds: number[];
  contactEmails: string[];
  notified: number[];
  createdAt: string;
}

export interface CommandLogEntry {
  id: string;
  cmd: string;
  ts: number;
  ok: boolean;
  source: 'shell' | 'pipeline' | 'vm' | 'portal' | 'typed';
  principal?: string;
}

export interface CliState {
  loggedIn: boolean;
  principal: PrincipalRef | null;
  subscriptionId?: string;
  extensions?: string[];
  defaults: Record<string, string>;
  history: string[];
  commandLog: CommandLogEntry[];
  env: Record<string, string>;
  cwd: string;
  kubeContext?: string | null;
  acrLogins: string[];
  dockerLogins: string[];
  knownHosts: string[];
}

// ---------------- Sistema de ficheros virtual ----------------

export interface FsFile {
  t: 'f';
  d: string;
  mt: number;
  x?: boolean;
}

export interface FsDir {
  t: 'd';
  c: Record<string, FsNode>;
  mt: number;
}

export type FsNode = FsFile | FsDir;

// ---------------- Docker local ----------------

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  created: string;
  size: number;
  /** contenido de la app empaquetada */
  files: Record<string, string>;
  exposed?: number;
  cmd?: string;
  env?: Record<string, string>;
  base?: string;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: 'running' | 'exited';
  ports: { host: number; container: number }[];
  created: string;
  env: Record<string, string>;
}

// ---------------- Git local / Azure DevOps ----------------

export interface GitCommit {
  id: string;
  message: string;
  author: string;
  date: string;
  parents: string[];
  tree: Record<string, string>;
}

export interface LocalRepo {
  path: string;
  head: string;
  branches: Record<string, string | null>;
  commits: Record<string, GitCommit>;
  staged: Record<string, string | null> | null;
  remotes: Record<string, string>;
  upstream: Record<string, string>;
  userName?: string;
  userEmail?: string;
}

export interface DevOpsRepo {
  id: string;
  name: string;
  defaultBranch: string;
  branches: Record<string, string>;
  commits: Record<string, GitCommit>;
  policies: { minReviewers: number; buildValidationPipelineId?: string | null; requireLinkedWorkItem?: boolean } | null;
}

export interface PullRequest {
  id: number;
  repoId: string;
  title: string;
  description: string;
  source: string;
  target: string;
  status: 'active' | 'completed' | 'abandoned';
  createdBy: string;
  createdAt: string;
  approvals: string[];
  buildStatus?: 'none' | 'running' | 'succeeded' | 'failed';
  buildRunId?: string;
  mergeCommit?: string;
  /** Elementos de trabajo vinculados. */
  workItems?: number[];
}

export interface ServiceConnection {
  id: string;
  name: string;
  type: 'azurerm' | 'dockerregistry' | 'kubernetes';
  authScheme: 'ServicePrincipal' | 'WorkloadIdentityFederation' | 'ManagedIdentity' | 'Kubeconfig' | 'AcrToken';
  servicePrincipalAppId?: string;
  servicePrincipalObjectId?: string;
  subscriptionId?: string;
  scope?: string;
  registryId?: string;
  clusterId?: string;
  createdAt: string;
  isReady: boolean;
}

export interface DevOpsEnvironment {
  id: string;
  name: string;
  approvers: string[];
  requireApproval: boolean;
  deployments: { runId: string; pipelineName: string; time: string; status: string }[];
}

export interface VariableGroup {
  id: string;
  name: string;
  variables: Record<string, { value: string; isSecret: boolean }>;
}

export interface Pipeline {
  id: string;
  name: string;
  repoId: string;
  yamlPath: string;
  createdAt: string;
  variables: Record<string, { value: string; isSecret: boolean }>;
}

export type RunStatus = 'notStarted' | 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'canceled' | 'skipped' | 'succeededWithIssues';

export interface RunStep {
  id: string;
  name: string;
  status: RunStatus;
  log: string[];
  startedAt?: string;
  finishedAt?: string;
}

export interface RunJob {
  id: string;
  name: string;
  displayName: string;
  status: RunStatus;
  steps: RunStep[];
  environment?: string;
  dependsOn: string[];
  condition?: string;
}

export interface RunStage {
  id: string;
  name: string;
  displayName: string;
  status: RunStatus;
  jobs: RunJob[];
  dependsOn: string[];
  condition?: string;
  approval?: { environment: string; status: 'pending' | 'approved' | 'rejected'; by?: string } | null;
}

export interface PipelineRun {
  id: string;
  number: number;
  pipelineId: string;
  pipelineName: string;
  buildNumber: string;
  status: RunStatus;
  reason: 'manual' | 'individualCI' | 'pullRequest';
  sourceBranch: string;
  sourceVersion: string;
  commitMessage: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  stages: RunStage[];
  error?: string;
  artifacts: Record<string, Record<string, string>>;
  requestedBy: string;
  variables: Record<string, string>;
  /** Valores finales de los parámetros en tiempo de ejecución. */
  parameters?: Record<string, any>;
  /** YAML completo tras resolver plantillas y expresiones ${{ }}. */
  expandedYaml?: string;
  /** Plantillas incluidas (ruta → nº de usos). */
  templates?: Record<string, number>;
  /** Nº de intento (sube con "Volver a ejecutar las fases con errores"). */
  attempt?: number;
}

export interface WorkItem {
  id: number;
  type: 'Epic' | 'User Story' | 'Task' | 'Bug';
  title: string;
  state: 'New' | 'Active' | 'Resolved' | 'Closed';
  assignedTo?: string;
  createdAt: string;
  /** Desarrollo: pull requests y commits vinculados. */
  links?: { kind: 'pr' | 'commit'; id: string; title: string; repo?: string }[];
}

export interface DevOpsProject {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  repos: DevOpsRepo[];
  pipelines: Pipeline[];
  runs: PipelineRun[];
  serviceConnections: ServiceConnection[];
  environments: DevOpsEnvironment[];
  variableGroups: VariableGroup[];
  pullRequests: PullRequest[];
  workItems: WorkItem[];
}

export interface DevOpsState {
  organization: string;
  projects: DevOpsProject[];
  runCounter: number;
  prCounter: number;
  workItemCounter: number;
}

export interface CostEntry {
  resourceId: string;
  name: string;
  type: string;
  resourceGroup: string;
  subscriptionId: string;
  amount: number;
  deleted?: boolean;
}

export interface Settings {
  speed: 'instant' | 'fast' | 'realistic';
  theme: 'light' | 'dark';
  freeMode: boolean;
  userDisplayName: string;
  onboarded: boolean;
}

export interface CloudState {
  schema: number;
  createdAt: string;
  settings: Settings;
  tenant: { id: string; domain: string; displayName: string };
  me: { objectId: string; upn: string; displayName: string };
  subscriptions: Subscription[];
  currentSubscriptionId: string;
  resourceGroups: ResourceGroup[];
  resources: Resource[];
  activityLog: ActivityLogEntry[];
  users: EntraUser[];
  groups: EntraGroup[];
  apps: AppRegistration[];
  servicePrincipals: ServicePrincipal[];
  roleAssignments: RoleAssignment[];
  customRoles: RoleDefinition[];
  locks: Lock[];
  policyAssignments: PolicyAssignment[];
  deployments: Deployment[];
  deletedVaults: DeletedVault[];
  diagnosticSettings: DiagnosticSetting[];
  budgets: Budget[];
  notifications: PortalNotification[];
  alerts: AlertInstance[];
  emails: SimEmail[];
  events: SimEvent[];
  costs: Record<string, CostEntry>;
  costClock: number;
  cli: CliState;
  fs: FsDir;
  docker: { images: DockerImage[]; containers: DockerContainer[] };
  gitLocal: Record<string, LocalRepo>;
  devops: DevOpsState;
  recent: string[];
}

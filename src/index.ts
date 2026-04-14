import { defineIntegration, createRestHandler, IntegrationValidationError, fakeId, fakeArray, fakeEmail, fakeIsoTimestamp, fakeUrl, deriveSeed } from '@weldable/integration-core'

const rest = createRestHandler()

// ---------------------------------------------------------------------------
// find action helpers
// ---------------------------------------------------------------------------

const MIME_BY_TYPE: Record<string, string> = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
  folder: 'application/vnd.google-apps.folder',
  pdf: 'application/pdf',
}

/**
 * Translate the agent-facing `type` enum to a Drive `q` clause. Image and
 * video use prefix matching since Drive stores concrete subtypes like
 * 'image/png' and 'video/mp4'. 'any' → no clause.
 */
function mimeClauseForType(type: string): string | null {
  const t = type.toLowerCase()
  if (t === 'any' || !t) return null
  if (t === 'image') return "mimeType contains 'image/'"
  if (t === 'video') return "mimeType contains 'video/'"
  const mime = MIME_BY_TYPE[t]
  if (!mime) return null
  return `mimeType = '${mime}'`
}

/** Map a Drive mimeType back to the agent-facing `type` enum. */
function typeForMime(mime: string | undefined): string {
  if (!mime) return 'unknown'
  if (mime === 'application/vnd.google-apps.document') return 'document'
  if (mime === 'application/vnd.google-apps.spreadsheet') return 'spreadsheet'
  if (mime === 'application/vnd.google-apps.presentation') return 'presentation'
  if (mime === 'application/vnd.google-apps.folder') return 'folder'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return mime
}

/**
 * Escape a user-supplied string for interpolation into a Drive `q` clause.
 * Single quotes and backslashes must be escaped — otherwise names like
 * "Joe's Q1 budget" break the query.
 */
function escapeDriveQueryLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export default defineIntegration({
  id: 'google_drive',
  version: 2,
  name: 'Google Drive',
  description: 'Search, organize, and share files and folders in Google Drive.',
  icon: 'google-drive',
  exampleUsage: "Find the slide deck from last month's board meeting",
  auth: {
    type: 'oauth2',
    test: async (_, ctx) => ctx.http.get('/about', { query: { fields: 'user' } }).then(r => r.data as Record<string, unknown>),
  },
  baseUrl: 'https://www.googleapis.com/drive/v3',
  nangoScopes: 'openid,email,https://www.googleapis.com/auth/drive',
  nangoCredentialEnvPrefix: 'GOOGLE',
  actions: [
    // ── Files ─────────────────────────────────────────────────
    {
      actionId: 'find',
      name: 'Find files',
      description:
        'Find files in Google Drive by name, content, and type. Returns the most recently modified matches. Searches across all drives the user can access.',
      intents: [
        'find my google doc',
        'find a spreadsheet',
        'where is my budget sheet',
        'search google drive',
        'find the meeting notes',
        'locate a file in drive',
        'look for a file in google drive',
        'find files in google drive',
      ],
      inputFields: [
        {
          name: 'query',
          type: 'string',
          required: false,
          description: 'Free-text search matched against filename and file content.',
        },
        {
          name: 'type',
          type: 'enum',
          required: false,
          description: 'Filter by file type. Defaults to any.',
          default: 'any',
          options: [
            { label: 'Any', value: 'any' },
            { label: 'Document', value: 'document' },
            { label: 'Spreadsheet', value: 'spreadsheet' },
            { label: 'Presentation', value: 'presentation' },
            { label: 'Folder', value: 'folder' },
            { label: 'PDF', value: 'pdf' },
            { label: 'Image', value: 'image' },
            { label: 'Video', value: 'video' },
          ],
        },
        {
          name: 'limit',
          type: 'number',
          required: false,
          description: 'Maximum number of results to return. Default 20, max 100.',
          default: 20,
        },
      ],
      outputFields: [
        {
          name: 'files',
          type: 'array',
          description:
            'Matching files, most recently modified first. Each has { id, name, type, url, modifiedAt, owner }.',
        },
        {
          name: 'hasMore',
          type: 'boolean',
          description: 'True if more results exist beyond the limit. Narrow the query to see them.',
        },
      ],
      execute: async (args, ctx) => {
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        const type = typeof args.type === 'string' && args.type ? args.type : 'any'
        const rawLimit = typeof args.limit === 'number' ? args.limit : Number(args.limit ?? 20)
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), 100)
          : 20

        const clauses: string[] = ['trashed = false']
        if (query) {
          const escaped = escapeDriveQueryLiteral(query)
          clauses.push(`(name contains '${escaped}' or fullText contains '${escaped}')`)
        }
        const mimeClause = mimeClauseForType(type)
        if (mimeClause) clauses.push(mimeClause)
        if (type !== 'any' && !mimeClause && type !== '') {
          throw new IntegrationValidationError(
            `unknown type "${type}". Allowed: any, document, spreadsheet, presentation, folder, pdf, image, video`,
            'type',
          )
        }

        const res = await ctx.http.get('/files', {
          query: {
            q: clauses.join(' and '),
            pageSize: String(limit),
            orderBy: 'modifiedTime desc',
            fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress)),nextPageToken',
            includeItemsFromAllDrives: 'true',
            supportsAllDrives: 'true',
            corpora: 'allDrives',
          },
        })

        const data = res.data as {
          files?: Array<{
            id?: string
            name?: string
            mimeType?: string
            modifiedTime?: string
            webViewLink?: string
            owners?: Array<{ emailAddress?: string }>
          }>
          nextPageToken?: string
        }

        const files = (data.files ?? []).map(f => ({
          id: f.id ?? '',
          name: f.name ?? '',
          type: typeForMime(f.mimeType),
          url: f.webViewLink ?? '',
          modifiedAt: f.modifiedTime ?? '',
          owner: f.owners?.[0]?.emailAddress ?? '',
        }))

        return { files, hasMore: Boolean(data.nextPageToken) }
      },
      mockExecute: async (_args, ctx) => ({
        files: fakeArray(ctx.seed, 3, (s) => ({
          id: fakeId(s, 28),
          name: `mock-file-${s.slice(-4)}.txt`,
          type: 'document',
          url: fakeUrl(s),
          modifiedAt: fakeIsoTimestamp(s),
          owner: fakeEmail(s),
        })),
        hasMore: false,
      }),
    },
    {
      actionId: 'get_file',
      name: 'Get file metadata',
      description: 'Look up details about a file -- name, type, size, owners, and sharing links.',
      intents: [
        'get file details',
        'look up a drive file',
        'find file metadata',
        'check a file in drive',
        'what are the details of this file',
        'show info about a drive file',
        'who owns this file',
        'get the sharing link for a file',
      ],
      inputFields: [
        {
          name: 'fileId',
          type: 'string',
          required: true,
          description: 'The ID of the file.',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask, e.g. "id,name,mimeType,size,modifiedTime,owners,permissions,webViewLink".',
        },
        {
          name: 'supportsAllDrives',
          type: 'boolean',
          required: false,
          description: 'Whether the application supports shared drives.',
        },
      ],
      outputFields: [
        { name: 'id', type: 'string', description: 'The file ID.' },
        { name: 'name', type: 'string', description: 'The file name.' },
        { name: 'mimeType', type: 'string', description: 'The MIME type of the file.' },
        { name: 'webViewLink', type: 'string', description: 'A link to open the file in a browser.' },
        { name: 'modifiedTime', type: 'string', description: 'The last modified time (RFC 3339 format).' },
        { name: 'size', type: 'string', description: 'The file size in bytes (as a string for large numbers).' },
      ],
      execute: rest({ method: 'GET', path: '/files/{fileId}', paramMapping: { fileId: 'path', fields: 'query', supportsAllDrives: 'query' } }),
      mockExecute: async (args, ctx) => ({
        id: String(args.fileId ?? fakeId(ctx.seed, 28)),
        name: `mock-file.txt`,
        mimeType: 'text/plain',
        webViewLink: fakeUrl(ctx.seed),
        modifiedTime: fakeIsoTimestamp(ctx.seed),
        size: '1024',
      }),
    },
    {
      actionId: 'create_file',
      name: 'Create file or folder',
      description: 'Upload, save, or create a file or folder in Google Drive. Use mimeType "application/vnd.google-apps.folder" for folders, "application/vnd.google-apps.document" for Google Docs, "application/vnd.google-apps.spreadsheet" for Sheets, or "application/vnd.google-apps.presentation" for Slides.',
      intents: [
        'upload a file to drive',
        'save a document to drive',
        'create a new file in drive',
        'put this in google drive',
        'add a file to my drive',
        'make a new folder',
        'create a folder in drive',
        'set up a new google doc',
        'make a new spreadsheet in drive',
        'add a presentation to drive',
      ],
      inputFields: [
        {
          name: 'name',
          type: 'string',
          required: false,
          description: 'Name of the file or folder.',
        },
        {
          name: 'mimeType',
          type: 'string',
          required: false,
          description: 'MIME type. Use "application/vnd.google-apps.folder" for folders.',
        },
        {
          name: 'parents',
          type: 'object',
          required: false,
          description: 'Array of parent folder IDs. Omit for root.',
        },
        {
          name: 'description',
          type: 'string',
          required: false,
          description: 'Description of the file.',
        },
        {
          name: 'starred',
          type: 'boolean',
          required: false,
          description: 'Whether to star the file.',
        },
        {
          name: 'shortcutDetails',
          type: 'object',
          required: false,
          description: 'For shortcuts: { targetId: "file_id_to_link_to" }.',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask for the response.',
        },
      ],
      outputFields: [
        { name: 'id', type: 'string', description: 'The ID of the newly created file or folder.' },
        { name: 'name', type: 'string', description: 'The name of the created file or folder.' },
        { name: 'mimeType', type: 'string', description: 'The MIME type of the created file.' },
        { name: 'webViewLink', type: 'string', description: 'A link to open the file in a browser.' },
      ],
      execute: rest({
        method: 'POST',
        path: '/files',
        paramMapping: {
          name: 'body',
          mimeType: 'body',
          parents: 'body',
          description: 'body',
          starred: 'body',
          shortcutDetails: 'body',
          fields: 'query',
        },
      }),
      mockExecute: async (args, ctx) => ({
        id: fakeId(ctx.seed, 28),
        name: String(args.name ?? 'mock-file.txt'),
        mimeType: String(args.mimeType ?? 'text/plain'),
        webViewLink: fakeUrl(ctx.seed),
      }),
    },
    {
      actionId: 'update_file',
      name: 'Update file',
      description: 'Rename, move, star, trash, or update the description of a file. To move a file, set addParents and removeParents.',
      intents: [
        'rename a file in drive',
        'move a file to a folder',
        'star a file in drive',
        'trash a drive file',
        'change file name',
        'put this file in a different folder',
        'send a file to the trash',
        'bookmark a drive file',
        'update the description of a file',
      ],
      inputFields: [
        {
          name: 'fileId',
          type: 'string',
          required: true,
          description: 'The ID of the file to update.',
        },
        {
          name: 'name',
          type: 'string',
          required: false,
          description: 'New file name.',
        },
        {
          name: 'description',
          type: 'string',
          required: false,
          description: 'New description.',
        },
        {
          name: 'starred',
          type: 'boolean',
          required: false,
          description: 'Whether the file is starred.',
        },
        {
          name: 'trashed',
          type: 'boolean',
          required: false,
          description: 'Whether the file is trashed.',
        },
        {
          name: 'addParents',
          type: 'string',
          required: false,
          description: 'Comma-separated folder IDs to add as parents (move into).',
        },
        {
          name: 'removeParents',
          type: 'string',
          required: false,
          description: 'Comma-separated folder IDs to remove as parents (move out of).',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask for the response.',
        },
        {
          name: 'supportsAllDrives',
          type: 'boolean',
          required: false,
          description: 'Whether the application supports shared drives.',
        },
      ],
      outputFields: [
        { name: 'id', type: 'string', description: 'The file ID.' },
        { name: 'name', type: 'string', description: 'The updated file name.' },
        { name: 'mimeType', type: 'string', description: 'The MIME type of the file.' },
        { name: 'webViewLink', type: 'string', description: 'A link to open the file in a browser.' },
        { name: 'modifiedTime', type: 'string', description: 'The updated last modified time (RFC 3339 format).' },
      ],
      execute: rest({
        method: 'PATCH',
        path: '/files/{fileId}',
        paramMapping: {
          fileId: 'path',
          name: 'body',
          description: 'body',
          starred: 'body',
          trashed: 'body',
          addParents: 'query',
          removeParents: 'query',
          fields: 'query',
          supportsAllDrives: 'query',
        },
      }),
    },
    {
      actionId: 'copy_file',
      name: 'Copy file',
      description: 'Make a copy of a file in Google Drive.',
      intents: [
        'duplicate a file in drive',
        'make a copy of a document',
        'clone a file',
        'copy this doc',
        'create a duplicate of this file',
        'make a backup by copying a file',
        'copy a file to another folder',
        'back up a file by duplicating it',
      ],
      inputFields: [
        {
          name: 'fileId',
          type: 'string',
          required: true,
          description: 'The ID of the file to copy.',
        },
        {
          name: 'name',
          type: 'string',
          required: false,
          description: 'Name for the copy.',
        },
        {
          name: 'parents',
          type: 'object',
          required: false,
          description: 'Array of parent folder IDs for the copy.',
        },
        {
          name: 'description',
          type: 'string',
          required: false,
          description: 'Description for the copy.',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask for the response.',
        },
        {
          name: 'supportsAllDrives',
          type: 'boolean',
          required: false,
          description: 'Whether the application supports shared drives.',
        },
      ],
      outputFields: [
        { name: 'id', type: 'string', description: 'The ID of the copied file.' },
        { name: 'name', type: 'string', description: 'The name of the copied file.' },
        { name: 'mimeType', type: 'string', description: 'The MIME type of the copied file.' },
        { name: 'webViewLink', type: 'string', description: 'A link to open the copy in a browser.' },
      ],
      execute: rest({
        method: 'POST',
        path: '/files/{fileId}/copy',
        paramMapping: {
          fileId: 'path',
          name: 'body',
          parents: 'body',
          description: 'body',
          fields: 'query',
          supportsAllDrives: 'query',
        },
      }),
    },
    // ── Permissions (sharing) ────────────────────────────────
    {
      actionId: 'list_permissions',
      name: 'List permissions',
      description: 'See who has access to a file and what level of access they have.',
      intents: [
        'who has access to this file',
        'see sharing settings',
        'check who can see this doc',
        'list people with access',
        'show me who this is shared with',
        'who can edit this file',
        'view permissions on a drive file',
        'check sharing on a document',
      ],
      inputFields: [
        {
          name: 'fileId',
          type: 'string',
          required: true,
          description: 'The ID of the file.',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask, e.g. "permissions(id,role,type,emailAddress,displayName)".',
        },
        {
          name: 'pageSize',
          type: 'number',
          required: false,
          description: 'Maximum number of permissions to return (1-100).',
        },
        {
          name: 'supportsAllDrives',
          type: 'boolean',
          required: false,
          description: 'Whether the application supports shared drives.',
        },
      ],
      outputFields: [
        { name: 'permissions', type: 'array', description: 'Array of permission objects, each with id, role, type, emailAddress, and displayName.' },
        { name: 'nextPageToken', type: 'string', description: 'Token to retrieve the next page of results.' },
      ],
      execute: rest({ method: 'GET', path: '/files/{fileId}/permissions', paramMapping: { fileId: 'path', fields: 'query', pageSize: 'query', supportsAllDrives: 'query' } }),
      mockExecute: async (_args, ctx) => ({
        permissions: fakeArray(ctx.seed, 2, (s) => ({
          id: fakeId(s, 20),
          role: 'reader',
          type: 'user',
          emailAddress: fakeEmail(s),
          displayName: `User ${s.slice(-4)}`,
        })),
        nextPageToken: undefined,
      }),
    },
    {
      actionId: 'create_permission',
      name: 'Share file',
      description: 'Share a file with a user, group, domain, or anyone. Set role to "reader", "commenter", "writer", or "owner".',
      intents: [
        'share a file',
        'give someone access to a doc',
        'share this with the team',
        'make a file public',
        'grant access to a drive file',
        'invite someone to view a document',
        'let someone edit this file',
        'share this doc with a colleague',
        'add a collaborator to a file',
      ],
      inputFields: [
        {
          name: 'fileId',
          type: 'string',
          required: true,
          description: 'The ID of the file to share.',
        },
        {
          name: 'role',
          type: 'string',
          required: true,
          description: 'Access level: "reader", "commenter", "writer", or "owner".',
        },
        {
          name: 'type',
          type: 'string',
          required: true,
          description: 'Who to share with: "user", "group", "domain", or "anyone".',
        },
        {
          name: 'emailAddress',
          type: 'string',
          required: false,
          description: 'Email address (required when type is "user" or "group").',
        },
        {
          name: 'domain',
          type: 'string',
          required: false,
          description: 'Domain name (required when type is "domain").',
        },
        {
          name: 'sendNotificationEmail',
          type: 'boolean',
          required: false,
          description: 'Whether to send a notification email.',
        },
        {
          name: 'emailMessage',
          type: 'string',
          required: false,
          description: 'Custom message in the notification email.',
        },
        {
          name: 'transferOwnership',
          type: 'boolean',
          required: false,
          description: 'Required true when role is "owner".',
        },
        {
          name: 'supportsAllDrives',
          type: 'boolean',
          required: false,
          description: 'Whether the application supports shared drives.',
        },
      ],
      outputFields: [
        { name: 'id', type: 'string', description: 'The ID of the newly created permission.' },
        { name: 'role', type: 'string', description: 'The access level granted: reader, commenter, writer, or owner.' },
        { name: 'type', type: 'string', description: 'The type of grantee: user, group, domain, or anyone.' },
        { name: 'emailAddress', type: 'string', description: 'The email address of the grantee (if applicable).' },
      ],
      execute: rest({
        method: 'POST',
        path: '/files/{fileId}/permissions',
        paramMapping: {
          fileId: 'path',
          role: 'body',
          type: 'body',
          emailAddress: 'body',
          domain: 'body',
          sendNotificationEmail: 'query',
          emailMessage: 'query',
          transferOwnership: 'query',
          supportsAllDrives: 'query',
        },
      }),
    },
    {
      actionId: 'update_permission',
      name: 'Update permission',
      description: "Change someone's access level on a file.",
      intents: [
        "change someone's access level",
        'make them a viewer instead of editor',
        'downgrade permissions on a file',
        'upgrade someone to editor on a doc',
        "change a collaborator's role",
        'adjust sharing permissions',
        'give someone more access to a file',
        "restrict someone's access to a document",
      ],
      inputFields: [
        {
          name: 'fileId',
          type: 'string',
          required: true,
          description: 'The ID of the file.',
        },
        {
          name: 'permissionId',
          type: 'string',
          required: true,
          description: 'The ID of the permission to update.',
        },
        {
          name: 'role',
          type: 'string',
          required: true,
          description: 'New access level: "reader", "commenter", "writer", or "owner".',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask for the response.',
        },
        {
          name: 'supportsAllDrives',
          type: 'boolean',
          required: false,
          description: 'Whether the application supports shared drives.',
        },
      ],
      outputFields: [
        { name: 'id', type: 'string', description: 'The permission ID.' },
        { name: 'role', type: 'string', description: 'The updated access level.' },
        { name: 'type', type: 'string', description: 'The type of grantee: user, group, domain, or anyone.' },
        { name: 'emailAddress', type: 'string', description: 'The email address of the grantee (if applicable).' },
      ],
      execute: rest({ method: 'PATCH', path: '/files/{fileId}/permissions/{permissionId}', paramMapping: { fileId: 'path', permissionId: 'path', role: 'body', fields: 'query', supportsAllDrives: 'query' } }),
    },
    {
      actionId: 'delete_permission',
      name: 'Remove sharing',
      description: "Remove someone's access to a file.",
      intents: [
        "remove someone's access",
        'unshare a file',
        'revoke drive access',
        'stop sharing with someone',
        'take away access to a document',
        'kick someone out of a shared file',
        'remove a collaborator from a doc',
        'revoke edit access on a file',
      ],
      inputFields: [
        {
          name: 'fileId',
          type: 'string',
          required: true,
          description: 'The ID of the file.',
        },
        {
          name: 'permissionId',
          type: 'string',
          required: true,
          description: 'The ID of the permission to remove.',
        },
        {
          name: 'supportsAllDrives',
          type: 'boolean',
          required: false,
          description: 'Whether the application supports shared drives.',
        },
      ],
      outputFields: [
        { name: 'ok', type: 'boolean', description: 'True if the permission was successfully removed.' },
      ],
      execute: rest({ method: 'DELETE', path: '/files/{fileId}/permissions/{permissionId}', paramMapping: { fileId: 'path', permissionId: 'path', supportsAllDrives: 'query' } }),
    },
    // ── Comments ──────────────────────────────────────────────
    {
      actionId: 'list_comments',
      name: 'List comments',
      description: 'Read all comments on a file.',
      intents: [
        'see comments on a file',
        'read feedback on a doc',
        'check notes on a drive file',
        'show all comments on a document',
        'what did people say on this file',
        'pull up the comments on this doc',
        'view annotations on a drive file',
        'find all remarks on this document',
      ],
      inputFields: [
        {
          name: 'fileId',
          type: 'string',
          required: true,
          description: 'The ID of the file.',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask for the response.',
        },
        {
          name: 'pageSize',
          type: 'number',
          required: false,
          description: 'Maximum number of comments to return (1-100).',
        },
        {
          name: 'pageToken',
          type: 'string',
          required: false,
          description: 'Token for the next page of results.',
        },
        {
          name: 'includeDeleted',
          type: 'boolean',
          required: false,
          description: 'Whether to include deleted comments.',
        },
      ],
      outputFields: [
        { name: 'comments', type: 'array', description: 'Array of comment objects, each with id, content, author, createdTime, and resolved.' },
        { name: 'nextPageToken', type: 'string', description: 'Token to retrieve the next page of results.' },
      ],
      execute: rest({ method: 'GET', path: '/files/{fileId}/comments', paramMapping: { fileId: 'path', fields: 'query', pageSize: 'query', pageToken: 'query', includeDeleted: 'query' } }),
    },
    {
      actionId: 'create_comment',
      name: 'Create comment',
      description: 'Leave a comment on a file.',
      intents: [
        'add a comment to a file',
        'leave a note on a doc',
        'comment on a drive document',
        'annotate a file in drive',
        'write a remark on a document',
        'post feedback on a file',
        'attach a note to a drive file',
        'jot a comment on a doc',
      ],
      inputFields: [
        {
          name: 'fileId',
          type: 'string',
          required: true,
          description: 'The ID of the file to comment on.',
        },
        {
          name: 'content',
          type: 'string',
          required: true,
          description: 'The comment text.',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask for the response.',
        },
      ],
      outputFields: [
        { name: 'id', type: 'string', description: 'The ID of the newly created comment.' },
        { name: 'content', type: 'string', description: 'The text content of the comment.' },
        { name: 'createdTime', type: 'string', description: 'When the comment was created (RFC 3339 format).' },
        { name: 'resolved', type: 'boolean', description: 'Whether the comment thread has been resolved.' },
      ],
      execute: rest({ method: 'POST', path: '/files/{fileId}/comments', paramMapping: { fileId: 'path', content: 'body', fields: 'query' } }),
    },
    {
      actionId: 'update_comment',
      name: 'Update comment',
      description: 'Edit an existing comment on a file.',
      intents: [
        'edit a comment on a file',
        'change my comment on a doc',
        'fix a note I left on a drive file',
        'update my feedback on a document',
        'revise a comment I posted',
        'correct a remark on a file',
        'modify a comment in drive',
      ],
      inputFields: [
        {
          name: 'fileId',
          type: 'string',
          required: true,
          description: 'The ID of the file.',
        },
        {
          name: 'commentId',
          type: 'string',
          required: true,
          description: 'The ID of the comment to edit.',
        },
        {
          name: 'content',
          type: 'string',
          required: true,
          description: 'Updated comment text.',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask for the response.',
        },
      ],
      outputFields: [
        { name: 'id', type: 'string', description: 'The comment ID.' },
        { name: 'content', type: 'string', description: 'The updated text content of the comment.' },
        { name: 'modifiedTime', type: 'string', description: 'When the comment was last modified (RFC 3339 format).' },
        { name: 'resolved', type: 'boolean', description: 'Whether the comment thread has been resolved.' },
      ],
      execute: rest({ method: 'PATCH', path: '/files/{fileId}/comments/{commentId}', paramMapping: { fileId: 'path', commentId: 'path', content: 'body', fields: 'query' } }),
    },
    {
      actionId: 'delete_comment',
      name: 'Delete comment',
      description: 'Remove a comment from a file.',
      intents: [
        'remove a comment from a file',
        'delete a note on a doc',
        'erase a comment on a drive file',
        'wipe a remark from a document',
        'clear a comment I left on a file',
        'take down a note on a doc',
        'get rid of a comment in drive',
      ],
      inputFields: [
        {
          name: 'fileId',
          type: 'string',
          required: true,
          description: 'The ID of the file.',
        },
        {
          name: 'commentId',
          type: 'string',
          required: true,
          description: 'The ID of the comment to delete.',
        },
      ],
      outputFields: [
        { name: 'ok', type: 'boolean', description: 'True if the comment was successfully deleted.' },
      ],
      execute: rest({ method: 'DELETE', path: '/files/{fileId}/comments/{commentId}', paramMapping: { fileId: 'path', commentId: 'path' } }),
    },
    {
      actionId: 'reply_to_comment',
      name: 'Reply to comment',
      description: 'Reply to a comment on a file. Can also resolve or reopen the comment thread.',
      intents: [
        'reply to a comment on a doc',
        'respond to feedback on a file',
        'answer a comment in drive',
        'write back on a comment',
        'follow up on a note in a document',
        'resolve a comment thread',
        'reopen a comment thread',
        'chime in on a comment on a file',
      ],
      inputFields: [
        {
          name: 'fileId',
          type: 'string',
          required: true,
          description: 'The ID of the file.',
        },
        {
          name: 'commentId',
          type: 'string',
          required: true,
          description: 'The ID of the comment to reply to.',
        },
        {
          name: 'content',
          type: 'string',
          required: true,
          description: 'The reply text.',
        },
        {
          name: 'action',
          type: 'string',
          required: false,
          description: '"resolve" to resolve the comment thread, or "reopen" to reopen it.',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask for the response.',
        },
      ],
      outputFields: [
        { name: 'id', type: 'string', description: 'The ID of the newly created reply.' },
        { name: 'content', type: 'string', description: 'The text content of the reply.' },
        { name: 'createdTime', type: 'string', description: 'When the reply was created (RFC 3339 format).' },
        { name: 'action', type: 'string', description: 'The action taken on the thread: resolve or reopen.' },
      ],
      execute: rest({ method: 'POST', path: '/files/{fileId}/comments/{commentId}/replies', paramMapping: { fileId: 'path', commentId: 'path', content: 'body', action: 'body', fields: 'query' } }),
    },
    // ── Shared Drives ─────────────────────────────────────────
    {
      actionId: 'list_drives',
      name: 'List shared drives',
      description: 'Show all shared drives the user belongs to.',
      intents: [
        'show shared drives',
        'what shared drives am I in',
        'list team drives',
        'find my shared drives',
        'browse team drives',
        'what drives does my team have',
        'show me all shared drives',
        'list the drives I belong to',
      ],
      inputFields: [
        {
          name: 'pageSize',
          type: 'number',
          required: false,
          description: 'Maximum number of shared drives to return (1-100).',
          default: 10,
        },
        {
          name: 'pageToken',
          type: 'string',
          required: false,
          description: 'Token for the next page of results.',
        },
        {
          name: 'q',
          type: 'string',
          required: false,
          description: 'Search query for shared drives.',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask for the response.',
        },
      ],
      outputFields: [
        { name: 'drives', type: 'array', description: 'Array of shared drive objects, each with id and name.' },
        { name: 'nextPageToken', type: 'string', description: 'Token to retrieve the next page of results.' },
      ],
      execute: rest({ method: 'GET', path: '/drives', paramMapping: { pageSize: 'query', pageToken: 'query', q: 'query', fields: 'query' } }),
    },
    {
      actionId: 'get_drive',
      name: 'Get shared drive',
      description: 'Look up details about a specific shared drive.',
      intents: [
        'get shared drive info',
        'details about a team drive',
        'look up a shared drive',
        'show info for a team drive',
        'what is in this shared drive',
        'fetch shared drive details',
        'check a specific team drive',
      ],
      inputFields: [
        {
          name: 'driveId',
          type: 'string',
          required: true,
          description: 'The ID of the shared drive.',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask for the response.',
        },
      ],
      outputFields: [
        { name: 'id', type: 'string', description: 'The shared drive ID.' },
        { name: 'name', type: 'string', description: 'The name of the shared drive.' },
        { name: 'createdTime', type: 'string', description: 'When the shared drive was created (RFC 3339 format).' },
        { name: 'capabilities', type: 'object', description: 'What the current user can do in this shared drive (e.g. canAddChildren, canManageMembers).' },
      ],
      execute: rest({ method: 'GET', path: '/drives/{driveId}', paramMapping: { driveId: 'path', fields: 'query' } }),
    },
    {
      actionId: 'create_drive',
      name: 'Create shared drive',
      description: 'Set up a new shared drive for your team.',
      intents: [
        'make a new shared drive',
        'create a team drive',
        'set up a shared drive',
        'start a new team drive',
        'build a shared drive for the team',
        'provision a new shared drive',
        'create a collaborative drive',
        'add a new team drive',
      ],
      inputFields: [
        {
          name: 'requestId',
          type: 'string',
          required: true,
          description: 'An idempotency key (any unique string) to prevent duplicate creation.',
        },
        {
          name: 'name',
          type: 'string',
          required: true,
          description: 'Name for the shared drive.',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask for the response.',
        },
      ],
      outputFields: [
        { name: 'id', type: 'string', description: 'The ID of the newly created shared drive.' },
        { name: 'name', type: 'string', description: 'The name of the shared drive.' },
        { name: 'createdTime', type: 'string', description: 'When the shared drive was created (RFC 3339 format).' },
      ],
      execute: rest({ method: 'POST', path: '/drives', paramMapping: { requestId: 'query', name: 'body', fields: 'query' } }),
    },
    // ── About ─────────────────────────────────────────────────
    {
      actionId: 'get_about',
      name: 'Get account info',
      description: 'Check Drive storage usage, user profile, and supported export formats.',
      intents: [
        'check drive storage',
        'how much drive space do I have',
        'get drive account info',
        'how full is my google drive',
        'show my drive quota',
        'what is my drive storage limit',
        'how much space is left in my drive',
        'drive usage stats',
      ],
      inputFields: [
        {
          name: 'fields',
          type: 'string',
          required: true,
          description: 'Fields to include, e.g. "user,storageQuota,exportFormats".',
        },
      ],
      outputFields: [
        { name: 'user', type: 'object', description: "The authenticated user's profile (displayName, emailAddress, photoLink)." },
        { name: 'storageQuota', type: 'object', description: 'Storage quota info with limit, usage, usageInDrive, and usageInDriveTrash (all in bytes as strings).' },
      ],
      execute: rest({ method: 'GET', path: '/about', paramMapping: { fields: 'query' } }),
    },
    // ── Revisions ─────────────────────────────────────────────
    {
      actionId: 'list_revisions',
      name: 'List revisions',
      description: 'View the version history of a file.',
      intents: [
        'see version history of a file',
        'check past versions of a doc',
        'what changes were made to this file',
        'file history',
        'show previous versions of a document',
        'browse revision history in drive',
        'who edited this file and when',
        'see older versions of a doc',
        'track changes on a drive file',
      ],
      inputFields: [
        {
          name: 'fileId',
          type: 'string',
          required: true,
          description: 'The ID of the file.',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask for the response.',
        },
        {
          name: 'pageSize',
          type: 'number',
          required: false,
          description: 'Maximum number of revisions to return (1-1000).',
        },
      ],
      outputFields: [
        { name: 'revisions', type: 'array', description: 'Array of revision objects, each with id, modifiedTime, and lastModifyingUser.' },
        { name: 'nextPageToken', type: 'string', description: 'Token to retrieve the next page of results.' },
      ],
      execute: rest({ method: 'GET', path: '/files/{fileId}/revisions', paramMapping: { fileId: 'path', fields: 'query', pageSize: 'query' } }),
    },
    // ── Changes ───────────────────────────────────────────────
    {
      actionId: 'list_changes',
      name: 'List changes',
      description: 'See what has changed in Drive since a given point in time. Use get_about to retrieve the initial startPageToken.',
      intents: [
        'what changed in my drive recently',
        'recent drive activity',
        'see drive changes',
        'show me what happened in drive',
        'catch up on drive updates',
        'what files were modified lately',
        'drive activity log',
        'recent edits in google drive',
        'what was updated in my drive',
      ],
      inputFields: [
        {
          name: 'pageToken',
          type: 'string',
          required: true,
          description: 'Token from a previous list_changes response or from the startPageToken in get_about.',
        },
        {
          name: 'pageSize',
          type: 'number',
          required: false,
          description: 'Maximum number of changes to return (1-1000).',
        },
        {
          name: 'fields',
          type: 'string',
          required: false,
          description: 'Field mask for the response.',
        },
        {
          name: 'spaces',
          type: 'string',
          required: false,
          description: 'Comma-separated list of spaces: "drive" or "appDataFolder".',
        },
        {
          name: 'includeItemsFromAllDrives',
          type: 'boolean',
          required: false,
          description: 'Whether to include shared drive items.',
        },
        {
          name: 'supportsAllDrives',
          type: 'boolean',
          required: false,
          description: 'Whether the application supports shared drives.',
        },
      ],
      outputFields: [
        { name: 'changes', type: 'array', description: 'Array of change objects, each with time, fileId, and file metadata.' },
        { name: 'nextPageToken', type: 'string', description: 'Token to retrieve the next page of changes.' },
        { name: 'newStartPageToken', type: 'string', description: 'Token for the start of future changes (only present on the last page).' },
      ],
      execute: rest({
        method: 'GET',
        path: '/changes',
        paramMapping: {
          pageToken: 'query',
          pageSize: 'query',
          fields: 'query',
          spaces: 'query',
          includeItemsFromAllDrives: 'query',
          supportsAllDrives: 'query',
        },
      }),
    },
  ],
})

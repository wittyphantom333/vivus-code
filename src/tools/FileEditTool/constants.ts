// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .vivus/ folder
export const VIVUS_FOLDER_PERMISSION_PATTERN = '/.vivus/**'

// Permission pattern for granting session-level access to the global ~/.vivus/ folder
export const GLOBAL_VIVUS_FOLDER_PERMISSION_PATTERN = '~/.vivus/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'

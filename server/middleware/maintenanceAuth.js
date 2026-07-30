export function configuredMaintenanceToken(env = process.env) {
  return String(env.OPS_MAINTENANCE_TOKEN || env.FEISHU_DOCX_SOURCE_API_TOKEN || '').trim();
}

export function bearerToken(req) {
  const header = String(req.get('authorization') || '').trim();

  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

export function requireMaintenanceToken(req, res, next) {
  const token = configuredMaintenanceToken();

  if (token && bearerToken(req) === token) {
    next();
    return;
  }

  res.status(401).json({ success: false, message: 'Unauthorized' });
}

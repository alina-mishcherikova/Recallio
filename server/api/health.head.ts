// HEAD /api/health (public): same status and headers as GET, no body.
import { healthHandler } from '../services/health/health'

export default healthHandler

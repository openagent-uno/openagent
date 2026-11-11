export type {
  TransportSendStream,
  TransportRecvStream,
  TransportBiStream,
  TransportConnection,
  TransportNodeAddr,
  TransportEndpoint,
  TransportRuntime,
  LoopbackProxyHandle,
  PlatformTransport,
  PublicAccountTarget,
  RememberedLoopbackResult,
} from './transport-types';

export {
  COORDINATOR_ALPN,
  GATEWAY_ALPN,
  RpcError,
  rpcCall,
  type RpcOptions,
} from './coordinator-rpc';

export {
  SrpError,
  startLogin,
  respondLogin,
  verifyServer,
  makeRegistrationPayload,
  type SrpClientLogin,
} from './srp-client';

export {
  CertVerificationError,
  verifyCert,
  decodeCertPayload,
  parseCertFrame,
  type DeviceCert,
  type VerifyOptions,
} from './device-cert';

export {
  TicketError,
  decodeTicket,
  looksLikeTicket,
  type InviteTicket,
} from './ticket';

export {
  LoginError,
  login,
  register,
  refreshCert,
  fetchNetworkInfo,
  nodeIdToPubkeyBytes,
  type LoginParams,
  type RegisterParams,
  type LoginResult,
} from './login';

export {
  DialTimeoutError,
  dialWithTimeout,
} from './dial-helpers';

export {
  SessionDialer,
  type GatewayStream,
} from './session-dialer';

export {
  generateIdentity,
  identityFromSecret,
  type Identity,
} from './identity';

export {
  selectAgentForConnection,
  type DiscoverableAgent,
  type AgentSelectionOptions,
} from './agent-selection';

export {
  bytesToHex,
  hexToBytes,
  bytesToBase64,
  base64ToBytes,
} from './encoding';

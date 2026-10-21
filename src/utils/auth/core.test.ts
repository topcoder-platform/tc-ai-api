import {createHmac,generateKeyPairSync,sign} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import nock from 'nock';
import {apiAuthLayer} from './index';
import {mapUserToResourceId} from './resource-id';

const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const issuer=process.env.KEYCLOAK_ISSUER!;

/** Creates a signed local fixture with optional claim overrides; returns a JWT; signing errors propagate. */
function token(claims:Record<string,unknown>={},member=false):string {
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const now=Math.floor(Date.now()/1000);
  const payload=member ? {iss:'https://members.example.test',sub:'member-42',userId:42,roles:['administrator'],iat:now,exp:now+120,...claims}
    :{iss:issuer,aud:process.env.KEYCLOAK_AUDIENCE,sub:'service-account',azp:'test-client',gty:'client-credentials',scope:'sys1:use',iat:now,exp:now+120,...claims};
  const value=encode({alg:member?'HS256':'RS256',kid:member?undefined:'ai-test'})+'.'+encode(payload);
  const signature=member?createHmac('sha256',process.env.AUTH_SECRET!).update(value).digest():sign('RSA-SHA256',Buffer.from(value),keys.privateKey);
  return value+'.'+signature.toString('base64url');
}

beforeAll(()=>{
  const url=new URL(issuer);
  nock(url.origin).persist().get(url.pathname+'/protocol/openid-connect/certs')
    .reply(200,{keys:[{...keys.publicKey.export({format:'jwk'}),kid:'ai-test',alg:'RS256',use:'sig'}]});
});
afterAll(()=>nock.cleanAll());

describe('shared authentication boundary',()=>{
  it('validates RSA Keycloak tokens and isolates service resources from members',async()=>{
    const user=await apiAuthLayer.authenticateToken(token());
    expect(user).toMatchObject({kind:'service',isMachine:true,roles:[],scopes:['sys1:use'],clientId:'test-client'});
    expect(user?.userId).toBeUndefined();
    expect(mapUserToResourceId(user!)).toBe(`service:${encodeURIComponent(issuer)}:test-client`);
    expect(apiAuthLayer.authorizeUser(user!,new Request('https://api.example.test/v6/ai/workflows/system-one/start'))).toBe(true);
    const other=await apiAuthLayer.authenticateToken(token({scope:'read:groups'}));
    expect(apiAuthLayer.authorizeUser(other!,new Request('https://api.example.test/v6/ai/workflows/system-one/start'))).toBe(false);
  });
  it('preserves member roles and IDs but strips OAuth scopes',async()=>{
    const user=await apiAuthLayer.authenticateToken(token({scope:'sys1:use'},true));
    expect(user).toMatchObject({kind:'user',isMachine:false,userId:42,roles:['administrator'],scopes:[]});
    expect(mapUserToResourceId(user!)).toBe('42');
  });
  it('rejects wrong audiences, oversized lifetimes, tampering, and member-like service claims',async()=>{
    for(const bad of [token({aud:'wrong'}),token({exp:Math.floor(Date.now()/1000)+901}),token({userId:42}),
      token({roles:['administrator']}),token().slice(0,-12)+'invalid',token({isMachine:true},true)]) {
      expect(await apiAuthLayer.authenticateToken(bad)).toBeNull();
    }
  });
  it('shares a verified issuance cache across outbound provider instances',async()=>{
    vi.stubEnv('KEYCLOAK_CLIENT_ID','test-client');vi.stubEnv('KEYCLOAK_CLIENT_SECRET','synthetic-client-secret');
    vi.stubEnv('KEYCLOAK_SCOPE','sys1:use');
    const endpoint=new URL(process.env.KEYCLOAK_TOKEN_URL!);
    const issued=token();
    const issuance=nock(endpoint.origin).post(endpoint.pathname).once().reply(200,{access_token:issued,expires_in:120,token_type:'Bearer'});
    try {
      vi.resetModules();
      const {M2MService}=await import('./m2m.service');
      expect(await new M2MService().getM2MToken()).toBe(issued);
      expect(await new M2MService().getM2MToken()).toBe(issued);
      expect(issuance.isDone()).toBe(true);
    } finally {vi.unstubAllEnvs();}
  });
});

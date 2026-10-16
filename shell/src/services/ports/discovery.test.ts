import { expect, it } from 'vitest'
import { parseListeningPorts, parsePortTarget } from './discovery'

it('discovers only TCP listeners and deduplicates IPv4/IPv6 loopback endpoints', () => {
  const output = 'sl local_address rem_address st\n0: 00000000:0BB8 00000000:0000 0A\n1: 0100007F:0BB8 00000000:0000 0A\n2: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A\n3: 0100007F:0016 00000000:0000 01\n4: 0800000A:1538 00000000:0000 0A\n5: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A'
  expect(parseListeningPorts(output)).toEqual([{ host: 'localhost', port: 3000 }, { host: '10.0.0.8', port: 5432 }, { host: 'localhost', port: 8080 }])
})
it('accepts ports, remote-reachable names and bracketed IPv6 but rejects invalid targets', () => {
  expect(parsePortTarget('3000')).toEqual({ host: 'localhost', port: 3000 })
  expect(parsePortTarget('10.0.0.8:5432')).toEqual({ host: '10.0.0.8', port: 5432 })
  expect(parsePortTarget('[::1]:8080')).toEqual({ host: 'localhost', port: 8080 })
  for (const value of ['0', '65536', 'http://localhost:80', 'host:abc', '80;exit', '::1:80']) expect(() => parsePortTarget(value)).toThrow()
})

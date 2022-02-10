import { createConnectorMock } from '@hoprnet/hopr-core-ethereum'
import { dbMock, debug, privKeyToPeerId } from '@hoprnet/hopr-utils'
import Hopr, { type HoprOptions, sampleOptions } from '.'
import assert from 'assert'

const log = debug('hopr-core:test:index')

const peerId = privKeyToPeerId('0x1c28c7f301658b4807a136e9fcf5798bc37e24b70f257fd3e6ee5adcf83a8c1f')

describe('hopr core (instance)', async function () {
  it('should be able to start a hopr node instance without crashing', async function () {
    this.timeout(5000)
    log('Creating hopr node...')
    const connectorMock = createConnectorMock(peerId)
    const node = new Hopr(peerId, dbMock, connectorMock, sampleOptions as HoprOptions)
    log('Node created with Id', node.getId().toB58String())
    assert(node instanceof Hopr)
    log('Starting node')
    await node.start()

    await assert.doesNotReject(async () => await node.stop())
  })
})

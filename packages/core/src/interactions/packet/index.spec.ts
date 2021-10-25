import PeerId from 'peer-id'
import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import BN from 'bn.js'

import { subscribeToAcknowledgements, sendAcknowledgement } from './acknowledgement'
import {
  Address,
  Balance,
  Challenge,
  defer,
  HoprDB,
  PublicKey,
  Ticket,
  UINT256,
  createPoRValuesForSender,
  deriveAckKeyShare,
  UnacknowledgedTicket,
  u8aEquals
} from '@hoprnet/hopr-utils'

import { AcknowledgementChallenge, Packet } from '../../messages'
import { PacketForwardInteraction } from './forward'

const SECRET_LENGTH = 32

function createFakeTicket(privKey: PeerId, challenge: Challenge, counterparty: Address, amount: Balance) {
  return Ticket.create(
    counterparty,
    challenge,
    new UINT256(new BN(0)),
    new UINT256(new BN(0)),
    amount,
    UINT256.fromInverseProbability(new BN(1)),
    new UINT256(new BN(0)),
    privKey.privKey.marshal()
  )
}

function createFakeSendReceive(events: EventEmitter, self: PeerId) {
  const send = (destination: PeerId, protocol: any, msg: Uint8Array) => {
    events.emit('msg', msg, self, destination, protocol)
  }

  const subscribe = (protocol: string, foo: (msg: Uint8Array, sender: PeerId) => any) => {
    events.on('msg', (msg, sender, destination, protocolSubscription) => {
      if (self.equals(destination) && protocol === protocolSubscription) {
        foo(msg, sender)
      }
    })
  }

  return {
    send,
    subscribe
  }
}

describe('packet interaction', function () {

  let events = new EventEmitter()

  afterEach(function () {
    events.removeAllListeners()
  })

  it('acknowledgement workflow', async function () {
    const [self, counterparty] = await Promise.all(
      Array.from({ length: 2 }, (_) => PeerId.create({ keyType: 'secp256k1' }))
    )
    const db = HoprDB.createMock()
    const secrets = Array.from({ length: 2 }, (_) => randomBytes(SECRET_LENGTH))
    const { ackChallenge, ownKey, ticketChallenge } = createPoRValuesForSender(secrets[0], secrets[1])
    const ticket = createFakeTicket(self, ticketChallenge, PublicKey.fromPeerId(counterparty).toAddress(), new Balance(new BN(1)))
    const challenge = AcknowledgementChallenge.create(ackChallenge, self)
    const unack = new UnacknowledgedTicket(ticket, halfKey, self) 
    await db.storeUnacknowledgedTicket(ackChallenge, unack)

    const libp2pSelf = createFakeSendReceive(events, self)
    const libp2pCounterparty = createFakeSendReceive(events, counterparty)


    const fakePacket = new Packet(
      new Uint8Array(),
      challenge,
      ticket 
    )

    fakePacket.ownKey = ownKey
    fakePacket.ackKey = deriveAckKeyShare(secrets[0])
    fakePacket.nextHop = counterparty.pubKey.marshal()
    fakePacket.ackChallenge = ackChallenge
    fakePacket.previousHop = PublicKey.fromPeerId(self)

    fakePacket.storeUnacknowledgedTicket(db)

    const ackReceived = defer<void>()
    const ev = new EventEmitter()

    subscribeToAcknowledgements(libp2pSelf.subscribe, db, ev, self, () => {
      ackReceived.resolve()
    })

    sendAcknowledgement(fakePacket, self, libp2pCounterparty.send, counterparty)

    await ackReceived.promise
  })

  it('packet-acknowledgement workflow', async function () {
    const [sender, relay0, relay1, relay2, receiver] = await Promise.all(
      Array.from({ length: 5 }, (_) => PeerId.create({ keyType: 'secp256k1' }))
    )
    const db = HoprDB.createMock()


    const libp2pSender = createFakeSendReceive(events, sender)
    const libp2pRelay0 = createFakeSendReceive(events, relay0)
    const libp2pRelay1 = createFakeSendReceive(events, relay1)
    const libp2pRelay2 = createFakeSendReceive(events, relay2)
    const libp2pReceiver = createFakeSendReceive(events, receiver)

    const testMsg = new TextEncoder().encode('testMsg')
    const packet = await Packet.create(testMsg, [relay0, relay1, relay2, receiver], sender, db)

    const msgDefer = defer<void>()

    const senderInteraction = new PacketForwardInteraction(
      libp2pSender.subscribe,
      libp2pSender.send,
      sender,
      console.log,
      db
    )

    // TODO: improve
    new PacketForwardInteraction(libp2pRelay0.subscribe, libp2pRelay0.send, relay0, console.log, db)
    new PacketForwardInteraction(libp2pRelay1.subscribe, libp2pRelay1.send, relay1, console.log, db)
    new PacketForwardInteraction(libp2pRelay2.subscribe, libp2pRelay2.send, relay2, console.log, db)
    new PacketForwardInteraction(
      libp2pReceiver.subscribe,
      libp2pReceiver.send,
      receiver,
      (msg: Uint8Array) => {
        if (u8aEquals(msg, testMsg)) {
          msgDefer.resolve()
        }
      },
      db
    )

    senderInteraction.interact(relay0, packet)

    await msgDefer.promise
  })
})

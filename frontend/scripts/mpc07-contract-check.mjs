import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth'
import { initializeApp } from 'firebase/app'
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions'
import { connectFirestoreEmulator, doc, getDoc, getFirestore } from 'firebase/firestore'

const PROJECT_ID =
  process.env.GCLOUD_PROJECT ||
  process.env.FIREBASE_CONFIG?.match(/\"projectId\":\"([^\"]+)\"/)?.[1] ||
  'demo-hybrid-horse-race'

const firebaseConfig = {
  apiKey: 'demo-api-key',
  authDomain: `${PROJECT_ID}.firebaseapp.com`,
  projectId: PROJECT_ID,
  appId: '1:123456789:web:abcdef',
  messagingSenderId: '123456789',
}

async function flushFirestore() {
  const url = `http://127.0.0.1:8081/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`
  const res = await fetch(url, { method: 'DELETE' })
  if (!res.ok) {
    throw new Error(`Failed to flush firestore emulator: ${res.status} ${await res.text()}`)
  }
}

function hasCode(error, code) {
  const maybeCode = error && typeof error === 'object' ? error.code : undefined
  if (typeof maybeCode === 'string' && maybeCode.includes(code)) return true
  return String(error).includes(code)
}

function horseStats(base) {
  return {
    Speed: base,
    Stamina: base,
    Power: base,
    Guts: base,
    Start: base,
    Luck: base,
  }
}

let appSeq = 0
async function createClient() {
  appSeq += 1
  const app = initializeApp(firebaseConfig, `contract-check-${appSeq}`)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  await signInAnonymously(auth)

  const functions = getFunctions(app, 'asia-northeast3')
  const firestore = getFirestore(app)
  connectFunctionsEmulator(functions, '127.0.0.1', 5001)
  connectFirestoreEmulator(firestore, '127.0.0.1', 8081)

  return {
    firestore,
    createGuestSession: httpsCallable(functions, 'createGuestSession'),
    createRoom: httpsCallable(functions, 'createRoom'),
    joinRoom: httpsCallable(functions, 'joinRoom'),
    setPlayerReady: httpsCallable(functions, 'setPlayerReady'),
    startGame: httpsCallable(functions, 'startGame'),
    selectHorse: httpsCallable(functions, 'selectHorse'),
    leaveRoom: httpsCallable(functions, 'leaveRoom'),
    updatePlayerName: httpsCallable(functions, 'updatePlayerName'),
  }
}

async function main() {
  await flushFirestore()

  const hostClient = await createClient()
  const guestClient = await createClient()
  const outsiderClient = await createClient()

  const host = (await hostClient.createGuestSession({})).data
  const guest = (await guestClient.createGuestSession({})).data
  const outsider = (await outsiderClient.createGuestSession({})).data

  const room = (
    await hostClient.createRoom({
      playerId: host.guestId,
      sessionToken: host.sessionToken,
      hostName: 'Host One',
      title: 'MPC07-Auth-Contract',
      maxPlayers: 2,
      roundCount: 1,
      rerollLimit: 1,
    })
  ).data

  const guestJoin = (
    await guestClient.joinRoom({
      roomId: room.roomId,
      playerId: guest.guestId,
      sessionToken: guest.sessionToken,
      playerName: 'Guest1',
    })
  ).data

  let identityMismatchDenied = false
  try {
    await outsiderClient.joinRoom({
      roomId: room.roomId,
      playerId: host.guestId,
      sessionToken: outsider.sessionToken,
      playerName: 'BadActor',
    })
  } catch (error) {
    identityMismatchDenied = hasCode(error, 'permission-denied')
  }

  await hostClient.setPlayerReady({
    roomId: room.roomId,
    playerId: host.guestId,
    sessionToken: host.sessionToken,
    joinToken: room.joinToken,
    isReady: true,
  })
  await guestClient.setPlayerReady({
    roomId: room.roomId,
    playerId: guest.guestId,
    sessionToken: guest.sessionToken,
    joinToken: guestJoin.joinToken,
    isReady: true,
  })

  const startGameRes = (
    await hostClient.startGame({
      roomId: room.roomId,
      playerId: host.guestId,
      sessionToken: host.sessionToken,
      joinToken: room.joinToken,
    })
  ).data

  const hostSelect = (
    await hostClient.selectHorse({
      roomId: room.roomId,
      playerId: host.guestId,
      sessionToken: host.sessionToken,
      joinToken: room.joinToken,
      horseStats: horseStats(12),
    })
  ).data
  const guestSelect = (
    await guestClient.selectHorse({
      roomId: room.roomId,
      playerId: guest.guestId,
      sessionToken: guest.sessionToken,
      joinToken: guestJoin.joinToken,
      horseStats: horseStats(13),
    })
  ).data

  await guestClient.updatePlayerName({
    roomId: room.roomId,
    playerId: guest.guestId,
    sessionToken: guest.sessionToken,
    joinToken: guestJoin.joinToken,
    name: '테스트 01',
  })
  const guestDoc = await getDoc(doc(hostClient.firestore, 'rooms', room.roomId, 'players', guest.guestId))
  const nameUpdated = guestDoc.exists() && guestDoc.data().name === '테스트 01'

  const results = [
    { contract: 'AUTH-IDENTITY', passed: identityMismatchDenied, detail: 'Auth identity mismatch is blocked' },
    { contract: 'ROOM-JOIN', passed: !!room.roomId && !!guestJoin.joinToken, detail: 'Host create + guest join works' },
    {
      contract: 'PIPELINE-START',
      passed:
        startGameRes.status === 'horseSelection' &&
        hostSelect.nextStatus === 'horseSelection' &&
        guestSelect.nextStatus === 'augmentSelection',
      detail: 'Start game -> horse selection pipeline is valid',
    },
    { contract: 'PLAYER-NAME', passed: nameUpdated, detail: 'updatePlayerName is persisted to Firestore' },
  ]

  await guestClient.leaveRoom({
    roomId: room.roomId,
    playerId: guest.guestId,
    sessionToken: guest.sessionToken,
    joinToken: guestJoin.joinToken,
  })
  await hostClient.leaveRoom({
    roomId: room.roomId,
    playerId: host.guestId,
    sessionToken: host.sessionToken,
    joinToken: room.joinToken,
  })

  const passCount = results.filter((row) => row.passed).length
  console.log('\nMPC-07 Contract Results')
  console.log('=======================')
  for (const row of results) {
    console.log(`${row.passed ? 'PASS' : 'FAIL'} | Contract-${row.contract} | ${row.detail}`)
  }
  console.log(`Summary: ${passCount}/${results.length} passed`)
  if (passCount !== results.length) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

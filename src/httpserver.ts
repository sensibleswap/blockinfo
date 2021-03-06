import express = require('express')
import request = require('superagent')
import fs = require('fs')
const Rabin = require('./rabin/rabin')

const app = express()

const allowCors = function (req, res, next) {
    res.header('Access-Control-Allow-Origin', req.headers.origin);
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', ['Content-Type', 'Content-Encoding']);
    res.header('Access-Control-Allow-Credentials', 'true');
    next();
};
app.use(allowCors)

const server: any = {}

server.app = app

let httpserver

const TIMEOUT = 30000 // 30s
const PUBKEY_LEN = 384

function getUInt32Buf(amount: number) {
    const buf = Buffer.alloc(4, 0)
    buf.writeUInt32LE(amount)
    return buf
}

function toBufferLE(num: BigInt, width: number) {
    const hex = num.toString(16);
    const buffer = Buffer.from(hex.padStart(width * 2, '0').slice(0, width * 2), 'hex');
    buffer.reverse();
    return buffer;
}

async function getMetaSvBlockInfo() {
    const blockRes = await request.get(`https://apiv2.metasv.com/block/info`).timeout(TIMEOUT)
    if (blockRes.status !== 200) {
        return false
    }
    return blockRes.body
}

async function getSensibleBlockInfo() {
    const blockRes = await request.get(
        `https://api.sensiblequery.com/blockchain/info`
    ).timeout(TIMEOUT)
    if (blockRes.status !== 200 || blockRes.body.code !== 0) {
        return false
    }
    const blockData = blockRes.body.data
    blockData.blocks = blockData.blocks - 1
    return blockData
}

async function getWocBlockInfo() {
    const blockRes = await request.get(
        `https://api.whatsonchain.com/v1/bsv/main/chain/info`
    ).timeout(TIMEOUT)
    if (blockRes.status !== 200) {
        return false
    }

    blockRes.body.bestBlockHash = blockRes.body.bestblockhash
    blockRes.body.medianTime = blockRes.body.mediantime
    return blockRes.body
}

async function getBlockInfo(source: string) {
    if (source === 'sensible') {
        return getSensibleBlockInfo()
    } else if (source === 'metasv') {
        return getMetaSvBlockInfo()
    } else if (source === 'woc') {
        return getWocBlockInfo()
    } else {
        throw Error('wrong source config')
    }
}

server.start = function (config) {

    if (!process.env.RABIN_P || !process.env.RABIN_Q) {
        throw Error('need rabin private key in env')
    }

    const rabinPrivateKey = {
        p: BigInt(process.env.RABIN_P),
        q: BigInt(process.env.RABIN_Q)
    }
    const rabinPubKey = Rabin.privKeyToPubKey(rabinPrivateKey.p, rabinPrivateKey.q)
    const rabinPubKeyhex = toBufferLE(rabinPubKey, PUBKEY_LEN).toString('hex')

    app.get('/', async function(req, res) {
        const blockData = await getBlockInfo(config.source)
        if (blockData === false) {
            console.log('getBlockHeight failed: ',res, res.body)
            res.json({code: 1, msg: 'getBlockHeight failed'})
            return
        }

        let userdata = Buffer.alloc(0)
        if (req.query.nonce) {
            userdata = Buffer.from(req.query.nonce, 'hex')
        }
        const blockHash = Buffer.from(blockData.bestBlockHash, 'hex')
        blockHash.reverse()
        const rabinMsg = Buffer.concat([
            getUInt32Buf(blockData.blocks),
            getUInt32Buf(blockData.medianTime),
            blockHash, // block hash
            Buffer.from('426974636f696e205356', 'hex'),
            userdata,
        ])

        let rabinSignResult = Rabin.sign(rabinMsg.toString('hex'), rabinPrivateKey.p, rabinPrivateKey.q, rabinPubKey)
        const rabinSign = toBufferLE(rabinSignResult.signature, PUBKEY_LEN).toString('hex')
        const rabinPadding = Buffer.alloc(rabinSignResult.paddingByteCount, 0).toString('hex')

        const data = {
            "chain":"Bitcoin SV",
            "height": blockData.blocks,
            "median_time_past": blockData.medianTime, 
            "block": blockData.bestBlockHash,
            "timestamp": Math.floor(new Date().getTime() / 1000),
            "digest": rabinMsg.toString('hex'),
            "signatures":{
                "rabin":{
                    "public_key": rabinPubKeyhex,
                    "signature": rabinSign,
                    "padding": rabinPadding,
                }
            }
        }
        res.json(data)
    })

    httpserver = app.listen(config.port, config.ip, function () {
        console.log("start at listen %s, %s:%s", config.source, config.ip, config.port)
    })
}

server.closeFlag = false

server.close = async function () {
    server.closeFlag = true
    await httpserver.close()
}

async function main() {
    const path = process.argv[2]
    const config = JSON.parse(fs.readFileSync(path).toString())
    server.start(config)
}

main()
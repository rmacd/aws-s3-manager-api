// global params
var AWS_BUCKET = process.env.AWS_BUCKET || 'quackophage';

var AWS = require('aws-sdk');
const aws_s3URI_allUsers = "http://acs.amazonaws.com/groups/global/AllUsers";

// for debug - inspections only
const util = require('util');

// cache responses from AWS
const NodeCache = require("node-cache");
const cache = new NodeCache();

const express = require('express');
const path = require('path');
const app = express();

// set up parser for PUT/POST requests
const bodyParser = require('body-parser');
let jsonParser = bodyParser.json();

// todo make region configurable

// AWS setup
const aws_s3 = new AWS.S3({apiVersion: '2006-03-01', signatureVersion: 'v4', region: 'eu-west-2'});
const aws_s3Params = {
    Bucket: process.env.AWS_BUCKET || 'rsviolin' // 'quackophage'
};

// Serve the static files from the React app
app.use(express.static(path.join(__dirname, 'fe/build')));

app.get('/api/version', (req, res) => {
    res.json({version: 1});
});

app.get('/debug', async (req, res) => {
    debugger;
});

function generateSignedLink(object_key) {
    return new Promise(((resolve, reject) => {
        let params = Object.assign({Key: object_key, Expires: 60}, aws_s3Params);
        console.log("GET ", params, "(signed link)");
        aws_s3.getSignedUrl(
            'getObject', params, ((err, url) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({signedLink: url});
                }
            })
        );
    }));
}

function setVisibility(object_key, is_public) {
    return new Promise((((resolve, reject) => {
        let aclString = (is_public) ? 'public-read' : 'private';
        let params = Object.assign({Key: object_key, ACL: aclString}, aws_s3Params);
        aws_s3.putObjectAcl(params, ((err, res) => {
            if (err) {
                reject(false);
            } else {
                console.log(res);
                resolve(false);
            }
        }));
    })));
}

app.put('/api/items', jsonParser, async function (req, res) {
    if (req.body !== undefined && req.body.item !== undefined && req.body.is_public !== undefined) {
        const setACL = await setVisibility(decodeURIComponent(req.body.item), req.body.is_public);
        console.log("called setACL", setACL);
        if (setACL) {
            // only if it was successful
            res.status(202);
        }
    }
    res.status(400);
});

app.get('/api/items', async function (req, res) {
    let getACL = (req.query.getACL !== undefined);
    let queryPath = req.query.path;
    let delimiter = '/';

    if (req.query.download !== undefined) {
        const signedLink = await generateSignedLink(decodeURIComponent(req.query.download));
        await res.json(signedLink);
        return;
    }

    let params = Object.assign({Delimiter: delimiter, Prefix: queryPath}, aws_s3Params);
    console.log(req.method, req.path, params, {getACL: getACL});

    let objectList = await getObjects(params);

    objectList.queryPath = (undefined !== queryPath) ? queryPath : '';

    if (getACL) {
        let objectACLList = await populateACL(objectList);
        await res.json(objectACLList);
    } else {
        await res.json(objectList);
    }
});

// Handles any requests that don't match the ones above
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname + '/fe/build/index.html'));
});

const port = process.env.PORT || 5000;
app.listen(port);
console.log('App is listening on port ' + port);

function getObjects(params) {
    return new Promise((resolve, reject) => {
        aws_s3.listObjectsV2(params, function (err, data) {
            if (err) {
                console.log("error", err);
                reject(err);
            } else {
                console.log(data);
                resolve(new AWSListBucketResponse(data, params));
            }
        })
    });
}

function populateACL(objectList) {
    return new Promise(async (resolve, reject) => {
        for (let obj of objectList.objects) {
            if (obj.type === "object") {
                obj.is_public = await obj_isPublic(obj.object_key);
            }
        }
        resolve(objectList);
    });
}

function obj_isPublic(object_key) {
    let params = Object.assign({Key: object_key}, aws_s3Params);
    return aws_s3.getObjectAcl(params, function (err, data) {
        if (err) {
            console.log(params, err, err.stack);
        } else {
            // console.log(util.inspect(data, {depth: 4}));
            return data;
        }
    }).promise().then(value => {
        let acl = hasPublicGrant(value.Grants);
        console.log(object_key, {ACL: acl});
        return acl;
    });
}

function hasPublicGrant(grants) {
    let status = false;
    grants.forEach(x => {
        if (x.Permission === "READ"
            && x.Grantee.Type === "Group"
            && x.Grantee.URI === aws_s3URI_allUsers) {
            status = true;
        }
    });
    return status;
}

class AWSListBucketResponse {
    constructor(data) {
        this.bucket = data.Name;
        this.truncated = data.IsTruncated;
        this.objects = Object.assign(
            new AWSListFoldersResponse(data.CommonPrefixes),
            new AWSListObjectsResponse(data)
        );
    }
}

class AWSListObjectsResponse {
    constructor(data) {
        let objects = [];
        for (let object of data.Contents) {
            let itemObject = {
                object_key: object.Key,
                name: object.Key.replace(/^.*[\\\/]/, ''),
                size: object.Size,
                type: "object",
            };
            if (data.Prefix === undefined || data.Prefix !== object.Key) {
                objects.push(itemObject);
            }
        }
        return objects;
    }
}

class AWSListFoldersResponse {
    constructor(data, params) {
        let objects = [];
        for (let object of data) {
            let itemObject = {
                name: object.Prefix.replace(/\/$/, '').replace(/^.*[\\\/]/, ''),
                object_key: object.Prefix,
                type: "folder"
            };
            objects.push(itemObject);
        }
        return objects;
    }
}
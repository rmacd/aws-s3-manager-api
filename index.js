// global params
var AWS_BUCKET = process.env.AWS_BUCKET || 'quackophage';

var AWS = require('aws-sdk');
const aws_s3URI_allUsers = "http://acs.amazonaws.com/groups/global/AllUsers";

const fs = require('fs');
crypt = require('crypto');

// for debug - inspections only
const util = require('util');

// cache responses from AWS
const NodeCache = require("node-cache");
const cache = new NodeCache();

const express = require('express');
const path = require('path');
const app = express();

// set up CSRF
const cookieParser = require('cookie-parser');
const csurf = require('csurf');
app.use(cookieParser());
app.use(csurf({cookie: {key: '_csrf', maxAge: 3600}}));

app.use(function (req, res, next) {
    var token = req.csrfToken();
    res.cookie('_csrf-aws-s3mgr', token);
    next();
});

// set up parser for PUT/POST requests
const bodyParser = require('body-parser');
let jsonParser = bodyParser.json();

// process multipart
var multipart = require('connect-multiparty');
var multipartMiddleware = multipart();

// AWS setup
// todo make region configurable
const aws_s3 = new AWS.S3({apiVersion: '2006-03-01', signatureVersion: 'v4', region: 'eu-west-2'});
const aws_s3Params = {
    Bucket: process.env.AWS_BUCKET || 'rmacd-testbucket'
};

// Serve the static files from the React app
app.use(express.static(path.join(__dirname, 'fe/build')));

app.get('/api/version', (req, res) => {
    res.json({version: 1, bucket: aws_s3Params.Bucket});
});

app.post('/api/upload', multipartMiddleware, async (req, res) => {
    let temp_path = req.files.file.path;
    let object_key = req.body.path + req.files.file.name;
    let content_type = req.files.file.headers['content-type'];
    console.log(`Uploading ${temp_path} (object_key: ${object_key})`);
    await uploadAndUnlinkObject(temp_path, object_key, content_type);
    res.status(201).send();
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
        aws_s3.putObjectAcl(params, (err, res) => {
            if (err) {
                reject(false);
            } else {
                resolve(true);
            }
        });
    })));
}

app.put('/api/items', jsonParser, async function (req, res) {
    if (req.body !== undefined && req.body.item !== undefined && req.body.is_public !== undefined) {
        const setACL = await setVisibility(decodeURIComponent(req.body.item), req.body.is_public);
        console.log("called setACL", setACL);
        if (setACL) {
            // only if it was successful
            await res.status(202).send();
        } else {
            await res.status(500).send();
        }
    }
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
// app.get('*', (req, res) => {
//     res.sendFile(path.join(__dirname + '/fe/build/index.html'));
// });

var proxy = require('express-http-proxy');
app.use('/', proxy('127.0.0.1:3000'));

const port = process.env.PORT || 5000;
app.listen(port);
console.log("App is listening on port", port);

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
        debugger;
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
            return data;
        }
    }).promise().then(value => {
        let acl = hasPublicGrant(value.Grants);
        console.log(object_key, {ACL: acl});
        return acl;
    });
}

function doUpload(params) {
    return new Promise(async (resolve, reject) => {
        aws_s3.putObject(params, function (err, data) {
            if (err) {
                reject(err);
            } else {
                resolve(data)
            }
        });
    });
}

async function uploadAndUnlinkObject(file_path, object_key, content_type) {
    fs.readFile(file_path, function (err, data) {
        if (err) {
            console.log(err);
            throw err;
        }
        let fileData = new Buffer.from(data, 'binary');
        let fileHash = crypt.createHash('md5')
            .update(fileData)
            .digest('base64');

        let params = Object.assign({
            Key: object_key,
            Body: fileData,
            ContentMD5: fileHash,
            ContentType: (undefined === content_type) ? 'binary' : content_type
        }, aws_s3Params);
        let uploadResponse = doUpload(params)
            .then(response => {
                console.log("Response", object_key, response);
                fs.unlink(file_path, function () {
                    console.log("Unlinked", file_path);
                });
            })
            .catch((reason) => {
                console.log(reason, reason.stack);
            });
    })

    // console.log("complete", value);
    // console.log("unlinking", file_path);
    // fs.unlink(file_path, function () {
    //     console.log("deleted", file_path);
    // });

    // let resp = await aws_s3.putObject(params, function (err, data) {
    //     if (err) {
    //         console.log(params, err, err.stack);
    //     } else {
    //         return data;
    //     }
    // });
    // fs.unlink(file_path, function () {
    //     console.log("deleted", file_path);
    // });
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
        let _01 = [];
        new AWSListFoldersResponse(data.CommonPrefixes).getObjects().forEach(val => {_01.push(val)});
        new AWSListObjectsResponse(data).getObjects().forEach(val => {_01.push(val)});
        this.objects = _01;
    }
}

class AWSListObjectsResponse {
    constructor(data) {
        this.objects = [];
        for (let object of data.Contents) {
            let itemObject = {
                object_key: object.Key,
                name: object.Key.replace(/^.*[\\\/]/, ''),
                size: object.Size,
                type: "object",
            };
            if (data.Prefix === undefined || data.Prefix !== object.Key) {
                this.objects.push(itemObject);
            }
        }
    }
    getObjects() {
        return this.objects;
    }
}

class AWSListFoldersResponse {
    constructor(data) {
        this.objects = [];
        for (let object of data) {
            let itemObject = {
                name: object.Prefix.replace(/\/$/, '').replace(/^.*[\\\/]/, ''),
                object_key: object.Prefix,
                type: "folder"
            };
            this.objects.push(itemObject);
        }
    }
    getObjects() {
        return this.objects;
    }
}
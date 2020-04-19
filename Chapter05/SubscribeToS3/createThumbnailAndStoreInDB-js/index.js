var async = require('async');
var AWS = require('aws-sdk');
const gm = require('gm');
var util = require('util');
var _ = require('lodash');

var DEFAULT_MAX_WIDTH = 200;
var DEFAULT_MAX_HEIGHT = 200;
var DDB_TABLE = 'images';

var s3 = new AWS.S3();
var dynamodb = new AWS.DynamoDB();


function getImageType(key) {
    var typeMatch = key.match(/\.([^.]*)$/);
    if (!typeMatch) {
        throw new Error("Could not determine the image type for key ${key}");
    }
    var imageType = typeMatch[1];
    if (imageType !== "jpg" && imageType !== "png") {
        throw new Error("Unsupported image type: " + imageType);
    }
    return imageType;
}


exports.handler = (event, context, callback) => {
    // Read options from the event.
    console.log("Reading options from event:\n", util.inspect(event, {depth: 5}));
    var srcBucket = event.Records[0].s3.bucket.name;
    var srcKey = event.Records[0].s3.object.key;
    var dstBucket = srcBucket;
    var dstKey = "thumbs/" + srcKey;

    var imageType = getImageType(srcKey, callback);

    // Download the image from S3, transform, upload to a different S3 bucket
    // and write the metadata to DynamoDB
    async.waterfall([
            function downloadImage(next) {
                // Download the image from S3 into a buffer.
                s3.getObject({
                        Bucket: srcBucket,
                        Key: srcKey
                    },
                    next);
            },
            function tranformImage(response, next) {
                gm(response.Body).size(function (err, size) {
                    var metadata = response.Metadata;
                    console.log("Metadata:\n", util.inspect(metadata, {depth: 5}));

                    var max_width = _.get(metadata, 'width', DEFAULT_MAX_WIDTH);
                    var max_height = _.get(metadata, 'height', DEFAULT_MAX_HEIGHT);

                    // Infer the scaling factor to avoid stretching the image unnaturally.
                    var scalingFactor = Math.min(
                        max_width / size.width,
                        max_height / size.height
                    );
                    var width = scalingFactor * size.width;
                    var height = scalingFactor * size.height;

                    // Transform the image buffer in memory.
                    const resizedImage = this.resize(width, height);
                    resizedImage.toBuffer(imageType, function (err, buffer) {
                        if (err) {
                            next(err);
                        } else {
                            next(null, response.ContentType, metadata, buffer);
                        }
                    });
                });
            },
            function uploadThumbnail(contentType, metadata, data, next) {
                // Stream the transformed image to a different S3 bucket.
                s3.putObject({
                    Bucket: dstBucket,
                    Key: dstKey,
                    Body: data,
                    ContentType: contentType,
                    Metadata: metadata
                }, function (err, buffer) {
                    if (err) {
                        next(err);
                    } else {
                        next(null, metadata);
                    }
                });
            },
            function storeMetadata(metadata, next) {
                // adds metadata do DynamoDB
                var params = {
                    TableName: DDB_TABLE,
                    Item: {
                        name: {S: srcKey},
                        thumbnail: {S: dstKey},
                        timestamp: {S: (new Date().toJSON()).toString()},
                    }
                };
                if ('author' in metadata) {
                    params.Item.author = {S: metadata.author};
                }
                if ('title' in metadata) {
                    params.Item.title = {S: metadata.title};
                }
                if ('description' in metadata) {
                    params.Item.description = {S: metadata.description};
                }
                dynamodb.putItem(params, next);
            }], function (err) {
            if (err) {
                console.error(err);
            } else {
                console.log(
                    'Successfully resized ' + srcBucket + '/' + srcKey +
                    ' and uploaded to ' + dstBucket + '/' + dstKey
                );
            }
            callback();
        }
    );
};
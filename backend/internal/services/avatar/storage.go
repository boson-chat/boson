// Package avatar handles user profile-image uploads: it validates +
// normalizes (decode, square-crop, resize, re-encode) an uploaded image
// and stores it in Cloudflare R2 (S3-compatible), served via the CDN.
package avatar

import (
	"bytes"
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Storage is the object-store surface the avatar service needs. Behind an
// interface so tests use an in-memory fake and never touch live R2.
type Storage interface {
	Put(ctx context.Context, key string, data []byte, contentType string) error
	Delete(ctx context.Context, key string) error
}

// R2Storage is the Cloudflare R2 (S3-compatible) implementation. R2 ignores
// the AWS region (use the sentinel "auto") and is reached via a custom
// endpoint with path-style addressing.
type R2Storage struct {
	client *s3.Client
	bucket string
}

func NewR2Storage(accessKey, secretKey, endpoint, bucket string) *R2Storage {
	client := s3.New(s3.Options{
		Region:       "auto",
		BaseEndpoint: aws.String(endpoint),
		Credentials:  credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""),
		UsePathStyle: true,
	})
	return &R2Storage{client: client, bucket: bucket}
}

func (r *R2Storage) Put(ctx context.Context, key string, data []byte, contentType string) error {
	// Keys are content-addressed (include a hash), so objects are immutable —
	// cache them hard at the CDN/browser.
	_, err := r.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:       aws.String(r.bucket),
		Key:          aws.String(key),
		Body:         bytes.NewReader(data),
		ContentType:  aws.String(contentType),
		CacheControl: aws.String("public, max-age=31536000, immutable"),
	})
	return err
}

func (r *R2Storage) Delete(ctx context.Context, key string) error {
	_, err := r.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(r.bucket),
		Key:    aws.String(key),
	})
	return err
}

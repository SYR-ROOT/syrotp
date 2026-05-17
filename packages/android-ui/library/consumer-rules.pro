# kotlinx-serialization needs reflection-free codegen kept around
# for any @Serializable class consumers reach into via reflection.
# Library-defined types (Verification, VerificationStatus,
# StatusResponse) are safe by virtue of the compiler-generated
# `*$$serializer` companions; no extra rules needed today.
